use std::sync::Arc;

use eyre::{eyre, OptionExt, WrapErr};
use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use tauri::{ipc::Channel, AppHandle, State};
use tokio::sync::{watch, Semaphore};

use crate::{
    downloader::download_img_task::calculate_block_num,
    errors::{CommandError, CommandResult},
    extensions::AppHandleExt,
    jm_client::IMAGE_DOMAIN,
};

mod transfer;

#[derive(Default)]
pub struct OnlineReader(Mutex<Option<Session>>);

struct Session {
    id: String,
    pages: Vec<Page>,
    cancel: watch::Sender<bool>,
    slots: Arc<Semaphore>,
}

#[derive(Clone)]
struct Page {
    url: String,
    block_num: u32,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OnlineChapter {
    session_id: String,
    page_count: usize,
}

#[derive(Serialize, Type)]
#[serde(tag = "event", content = "data")]
pub enum OnlinePageEvent {
    Chunk(Vec<u8>),
    Complete { mime: String, blocks: u32 },
}

impl OnlineReader {
    fn begin(&self) -> (String, watch::Receiver<bool>) {
        let (cancel, receiver) = watch::channel(false);
        let id = uuid::Uuid::new_v4().to_string();
        let session = Session {
            id: id.clone(),
            pages: Vec::new(),
            cancel,
            slots: Arc::new(Semaphore::new(2)),
        };
        if let Some(old) = self.0.lock().replace(session) {
            old.cancel.send_replace(true);
        }
        (id, receiver)
    }

    fn close(&self, id: &str) {
        let mut current = self.0.lock();
        if current.as_ref().is_some_and(|session| session.id == id) {
            if let Some(session) = current.take() {
                session.cancel.send_replace(true);
            }
        }
    }
}

fn chapter_pages(chapter_id: i64, scramble_id: i64, names: Vec<String>) -> eyre::Result<Vec<Page>> {
    names
        .into_iter()
        .map(|name| {
            if name.is_empty() || name.contains(['/', '\\', '?', '#']) {
                return Err(eyre!("章节包含无效图片文件名"));
            }
            let stem = std::path::Path::new(&name)
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or_eyre("图片文件名无效")?;
            Ok(Page {
                url: format!("https://{IMAGE_DOMAIN}/media/photos/{chapter_id}/{name}"),
                block_num: calculate_block_num(scramble_id, chapter_id, stem),
            })
        })
        .collect()
}

#[tauri::command]
#[specta::specta]
pub fn start_online_reader(reader: State<'_, OnlineReader>) -> String {
    reader.begin().0
}

#[tauri::command]
#[specta::specta]
pub async fn open_online_chapter(
    app: AppHandle,
    reader: State<'_, OnlineReader>,
    session_id: String,
    chapter_id: i64,
) -> CommandResult<OnlineChapter> {
    if chapter_id <= 0 {
        return Err(CommandError::from(
            "打开在线章节失败",
            eyre!("章节ID必须为正数"),
        ));
    }
    let id = session_id;
    let mut cancel = reader
        .0
        .lock()
        .as_ref()
        .filter(|session| session.id == id)
        .ok_or_else(|| CommandError::from("打开在线章节失败", eyre!("在线阅读已关闭")))?
        .cancel
        .subscribe();
    let client = app.get_jm_client().inner().clone();
    let result = tokio::select! {
        result = async {
            let (chapter, scramble) = tokio::try_join!(client.get_chapter(chapter_id), client.get_scramble_id(chapter_id))?;
            chapter_pages(chapter_id, scramble, chapter.images)
        } => result,
        _ = cancel.changed() => Err(eyre!("在线阅读已关闭")),
    };
    let pages = match result {
        Ok(pages) => pages,
        Err(err) => {
            reader.close(&id);
            return Err(CommandError::from("打开在线章节失败", err));
        }
    };
    let page_count = pages.len();
    let mut current = reader.0.lock();
    let session = current
        .as_mut()
        .filter(|session| session.id == id)
        .ok_or_else(|| CommandError::from("打开在线章节失败", eyre!("在线阅读已切换章节")))?;
    session.pages = pages;
    Ok(OnlineChapter {
        session_id: id,
        page_count,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn stream_online_page(
    app: AppHandle,
    reader: State<'_, OnlineReader>,
    session_id: String,
    page_index: usize,
    on_chunk: Channel<OnlinePageEvent>,
) -> CommandResult<()> {
    let (page, mut cancel, slots) = {
        let current = reader.0.lock();
        let session = current
            .as_ref()
            .filter(|session| session.id == session_id)
            .ok_or_else(|| CommandError::from("读取在线页面失败", eyre!("在线阅读已关闭")))?;
        let page = session
            .pages
            .get(page_index)
            .cloned()
            .ok_or_else(|| CommandError::from("读取在线页面失败", eyre!("页码超出章节范围")))?;
        (page, session.cancel.subscribe(), session.slots.clone())
    };
    let client = app.get_jm_client().inner().clone();
    let result = tokio::select! {
        result = async {
            let _permit = slots.acquire_owned().await?;
            let mime = transfer::stream_image(&client, &page.url, |chunk| {
                on_chunk.send(OnlinePageEvent::Chunk(chunk.to_vec())).wrap_err("传输图片块失败")
            }).await?;
            on_chunk.send(OnlinePageEvent::Complete { mime, blocks: page.block_num })?;
            Ok(())
        } => result,
        _ = cancel.changed() => Err(eyre!("在线阅读已关闭")),
    };
    result.map_err(|err: eyre::Report| CommandError::from("读取在线页面失败", err))
}

#[tauri::command]
#[specta::specta]
pub fn close_online_reader(reader: State<'_, OnlineReader>, session_id: String) {
    reader.close(&session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_a_new_session_cancels_the_previous_one() {
        let reader = OnlineReader::default();
        let (old, old_cancel) = reader.begin();
        let (new, new_cancel) = reader.begin();
        assert!(*old_cancel.borrow());
        reader.close(&old);
        assert!(!*new_cancel.borrow());
        reader.close(&new);
        assert!(*new_cancel.borrow());
    }

    #[test]
    fn page_urls_keep_the_configured_image_host() {
        let pages = chapter_pages(123, 200, vec!["00001.jpg".to_owned()]).unwrap();
        assert_eq!(
            pages[0].url,
            format!("https://{IMAGE_DOMAIN}/media/photos/123/00001.jpg")
        );
        assert_eq!(pages[0].block_num, 0);
        assert!(chapter_pages(123, 200, vec!["../../other.jpg".to_owned()]).is_err());
    }
}
