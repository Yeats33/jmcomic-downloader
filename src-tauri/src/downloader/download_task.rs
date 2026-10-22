use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};

use eyre::{eyre, OptionExt, WrapErr};
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::{
    sync::{watch, Mutex, OwnedSemaphorePermit, SemaphorePermit},
    task::JoinSet,
    time::sleep,
};
use tracing::{instrument, Instrument};

use super::queue::{DownloadQueue, QueueCheckpoint, QueuedDownload};
use crate::{
    downloader::{
        download_img_task::{calculate_block_num, DownloadImgTask},
        download_manager::{read_downloaded_imgs_from_dir, ChapterDownloadedImgs},
        download_paths::DownloadPaths,
        download_task_state::DownloadTaskState,
        image_writes::ImageWrites,
    },
    events::DownloadEvent,
    extensions::{AppHandleExt, EyreReportToMessage},
    jm_client::IMAGE_DOMAIN,
    types::{ChapterInfo, Comic, DownloadFormat},
};

pub struct DownloadTask {
    pub app: AppHandle,
    pub comic: Arc<Comic>,
    pub chapter_info: Arc<ChapterInfo>,
    pub state_sender: watch::Sender<DownloadTaskState>,
    pub delete_sender: watch::Sender<()>,
    pub downloaded_img_count: Arc<AtomicU32>,
    pub total_img_count: Arc<AtomicU32>,
    pub(super) paths: DownloadPaths,
    pub(super) image_writes: ImageWrites,
    pub(super) deletion_lock: Arc<Mutex<()>>,
    process_finished: watch::Receiver<()>,
    pub(super) download_format: DownloadFormat,
    task_id: String,
    queue: Arc<DownloadQueue>,
    state_change: parking_lot::Mutex<()>,
}

impl DownloadTask {
    #[instrument(
        level = "error",
        skip_all,
        fields(
            comic_id = comic.id,
            comic_title = comic.name,
            chapter_id = chapter_id
        )
    )]
    pub fn new(app: AppHandle, mut comic: Comic, chapter_id: i64) -> eyre::Result<Arc<Self>> {
        comic
            .ensure_download_dir_fields(&app)
            .wrap_err("更新下载目录字段失败")?;

        let (root, format) = {
            let config = app.get_config();
            let config = config.read();
            (config.download_dir.clone(), config.download_format)
        };
        Self::from_queue(
            app,
            QueuedDownload {
                task_id: uuid::Uuid::new_v4().to_string(),
                comic,
                chapter_id,
                root,
                format,
                state: DownloadTaskState::Pending,
                total_img_count: 0,
            },
        )
    }

    pub(super) fn from_queue(app: AppHandle, entry: QueuedDownload) -> eyre::Result<Arc<Self>> {
        let comic = entry.comic.clone();
        let chapter_id = entry.chapter_id;

        let chapter_info = comic
            .chapter_infos
            .iter()
            .find(|chapter| chapter.chapter_id == chapter_id)
            .cloned()
            .ok_or_eyre(format!("未找到章节ID为`{chapter_id}`的章节信息"))?;

        let paths = DownloadPaths::new(&entry.root, &comic, &chapter_info)?;
        let queue = Arc::clone(app.get_download_manager().queue()?);
        let metadata_path = paths.chapter.join("章节元数据.json");
        let already_complete = match std::fs::read(&metadata_path) {
            Ok(bytes) => serde_json::from_slice::<ChapterInfo>(&bytes)
                .is_ok_and(|saved| saved.chapter_id == chapter_id),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        let state = if already_complete {
            DownloadTaskState::Completed
        } else {
            entry.state
        };
        let downloaded_dir = if already_complete {
            &paths.chapter
        } else {
            &paths.temporary
        };
        let downloaded_count =
            u32::try_from(read_downloaded_imgs_from_dir(downloaded_dir, true)?.len())?;
        queue.insert(QueuedDownload {
            comic: comic.clone(),
            state,
            ..entry.clone()
        })?;
        if already_complete {
            queue.update(QueueCheckpoint {
                task_id: &entry.task_id,
                chapter_id,
                state,
                total_img_count: downloaded_count,
            })?;
        }
        let (state_sender, _) = watch::channel(state);
        let (delete_sender, _) = watch::channel(());
        let (finished_sender, process_finished) = watch::channel(());

        let task = Arc::new(Self {
            app,
            comic: Arc::new(comic),
            chapter_info: Arc::new(chapter_info),
            state_sender,
            delete_sender,
            downloaded_img_count: Arc::new(AtomicU32::new(downloaded_count)),
            total_img_count: Arc::new(AtomicU32::new(if already_complete {
                downloaded_count
            } else {
                entry.total_img_count
            })),
            paths,
            image_writes: ImageWrites::new(),
            deletion_lock: Arc::new(Mutex::new(())),
            process_finished,
            download_format: entry.format,
            task_id: entry.task_id,
            queue,
            state_change: parking_lot::Mutex::new(()),
        });

        let process_task = task.clone();
        tauri::async_runtime::spawn(async move {
            process_task.process().await;
            drop(finished_sender);
        });

        Ok(task)
    }

    pub(super) fn is_busy(&self) -> bool {
        let state = *self.state_sender.borrow();
        state.is_active()
            || self.deletion_lock.try_lock().is_err()
            || !self.image_writes.is_idle()
            || (state == DownloadTaskState::Cancelled && !self.process_finished())
    }

    pub(super) fn process_finished(&self) -> bool {
        self.process_finished.has_changed().is_err()
    }

    pub async fn wait_until_stopped(&self) -> eyre::Result<OwnedSemaphorePermit> {
        let mut finished = self.process_finished.clone();
        while finished.changed().await.is_ok() {}
        self.image_writes.drain().await
    }

    pub fn validate_cleanup_paths(&self) -> eyre::Result<()> {
        self.paths.validate()
    }

    #[instrument(
        level = "error",
        skip_all,
        fields(
            comic_id = self.comic.id,
            comic_title = self.comic.name,
            chapter_id = self.chapter_info.chapter_id,
            chapter_title = self.chapter_info.chapter_title,
            order = self.chapter_info.order
        )
    )]
    async fn process(self: Arc<Self>) {
        self.emit_download_task_create_event();

        let mut state_receiver = self.state_sender.subscribe();
        state_receiver.mark_changed();

        let mut delete_receiver = self.delete_sender.subscribe();

        let mut permit = None;
        let mut download_task_option = None;

        loop {
            let state = *state_receiver.borrow();
            let state_is_downloading = state == DownloadTaskState::Downloading;
            let state_is_pending = state == DownloadTaskState::Pending;

            let download_task = async {
                download_task_option
                    .get_or_insert_with(|| Box::pin(self.download_chapter()))
                    .await;
            };

            tokio::select! {
                () = download_task, if state_is_downloading && permit.is_some() => {
                    download_task_option = None;
                    if let Some(permit) = permit.take() {
                        drop(permit);
                    }
                }

                () = self.acquire_chapter_permit(&mut permit), if state_is_pending => {}

                _ = state_receiver.changed() => {
                    self.handle_state_change(&mut permit, &mut state_receiver).await;
                    if *state_receiver.borrow() == DownloadTaskState::Cancelled {
                        return;
                    }
                }

                _ = delete_receiver.changed() => {
                    self.handle_delete_receiver_change(&mut permit).await;
                    return;
                }
            }
        }
    }

    #[instrument(level = "error", skip_all)]
    async fn download_chapter(self: &Arc<Self>) {
        let chapter_id = self.chapter_info.chapter_id;

        if let Err(err) = self.comic.save_comic_metadata() {
            let err_title = "保存元数据失败";
            let message = err.to_message();
            tracing::error!(err_title, message);

            self.set_state(DownloadTaskState::Failed);
            self.emit_download_task_update_event();

            return;
        }

        let should_download_cover = self.app.get_config().read().should_download_cover;
        if should_download_cover {
            if let Err(err) = self.download_cover().await {
                let err_title = "下载封面失败";
                let message = err.to_message();
                tracing::error!(err_title, message);

                self.set_state(DownloadTaskState::Failed);
                self.emit_download_task_update_event();

                return;
            }
        }

        let Some(urls_with_block_num) = self.get_urls_with_block_num(chapter_id).await else {
            return;
        };

        let Ok(total) = u32::try_from(urls_with_block_num.len()) else {
            self.set_state(DownloadTaskState::Failed);
            self.emit_download_task_update_event();
            return;
        };
        self.total_img_count.store(total, Ordering::Relaxed);
        self.downloaded_img_count.store(0, Ordering::Relaxed);
        self.set_state(DownloadTaskState::Downloading);

        let Some(temp_download_dir) = self.create_temp_download_dir() else {
            return;
        };

        self.clean_temp_download_dir(&temp_download_dir);

        let mut join_set = JoinSet::new();
        for (i, (url, block_num)) in urls_with_block_num.into_iter().enumerate() {
            let temp_download_dir = temp_download_dir.clone();
            let download_img_task =
                DownloadImgTask::new(self.clone(), url, i, temp_download_dir, block_num);
            join_set.spawn(download_img_task.process().in_current_span());
        }
        join_set.join_all().await;

        tracing::trace!("所有图片下载任务完成");

        let downloaded_img_count = self.downloaded_img_count.load(Ordering::Relaxed);
        let total_img_count = self.total_img_count.load(Ordering::Relaxed);
        if downloaded_img_count != total_img_count {
            let err_title = "下载不完整";
            let message =
                eyre!("总共有`{total_img_count}`张图片，但只下载了`{downloaded_img_count}`张")
                    .to_message();
            tracing::error!(err_title, message);

            self.set_state(DownloadTaskState::Failed);
            self.emit_download_task_update_event();

            return;
        }

        if let Err(err) = self.rename_temp_download_dir(&temp_download_dir) {
            let err_title = "保存下载目录失败";
            let message = err.to_message();
            tracing::error!(err_title, message);

            self.set_state(DownloadTaskState::Failed);
            self.emit_download_task_update_event();

            return;
        }

        if let Err(err) = self.chapter_info.save_chapter_metadata() {
            let err_title = "保存章节元数据失败";
            let message = err.to_message();
            tracing::error!(err_title, message);
        }

        self.sleep_between_chapter().await;
        tracing::info!("章节下载成功");

        self.set_state(DownloadTaskState::Completed);
        self.emit_download_task_update_event();
    }

    #[instrument(level = "error", skip_all)]
    async fn download_cover(&self) -> eyre::Result<()> {
        let cover_path = self.comic.get_cover_path().wrap_err("获取封面路径失败")?;

        let comic_id = self.comic.id;
        let url = format!("https://cdn-msp3.18comic.vip/media/albums/{comic_id}.jpg");

        let (img_data, _format) = self
            .app
            .get_jm_client()
            .get_img_data_and_format(&url)
            .await
            .wrap_err(format!("下载图片`{url}`失败"))?;

        std::fs::write(&cover_path, img_data)
            .wrap_err(format!("保存图片`{}`失败", cover_path.display()))?;

        Ok(())
    }

    #[instrument(level = "error", skip_all)]
    fn create_temp_download_dir(&self) -> Option<PathBuf> {
        let temp_download_dir = match self.chapter_info.get_temp_download_dir() {
            Ok(temp_download_dir) => temp_download_dir,
            Err(err) => {
                let err_title = "获取临时下载目录失败";
                let message = err.to_message();
                tracing::error!(err_title, message);

                self.set_state(DownloadTaskState::Failed);
                self.emit_download_task_update_event();

                return None;
            }
        };

        if let Err(err) = std::fs::create_dir_all(&temp_download_dir).map_err(eyre::Report::from) {
            let err_title = "创建临时下载目录失败";
            let message = err.to_message();
            tracing::error!(err_title, message);

            self.set_state(DownloadTaskState::Failed);
            self.emit_download_task_update_event();

            return None;
        }

        tracing::trace!("创建临时下载目录成功");

        Some(temp_download_dir)
    }

    #[instrument(level = "error", skip_all, fields(temp_download_dir = %temp_download_dir.display()))]
    fn rename_temp_download_dir(&self, temp_download_dir: &Path) -> eyre::Result<()> {
        let chapter_download_dir = self
            .chapter_info
            .chapter_download_dir
            .as_ref()
            .ok_or_eyre("`chapter_download_dir`字段为`None`")?;

        if chapter_download_dir.exists() {
            std::fs::remove_dir_all(chapter_download_dir)
                .wrap_err(format!("删除 `{}` 失败", chapter_download_dir.display()))?;
        }

        std::fs::rename(temp_download_dir, chapter_download_dir).wrap_err(format!(
            "将 `{}` 重命名为 `{}` 失败",
            temp_download_dir.display(),
            chapter_download_dir.display()
        ))?;

        Ok(())
    }

    #[instrument(level = "error", skip_all)]
    async fn get_urls_with_block_num(&self, chapter_id: i64) -> Option<Vec<(String, u32)>> {
        let jm_client = self.app.get_jm_client();

        let res = tokio::try_join!(
            jm_client.get_scramble_id(chapter_id),
            jm_client.get_chapter(chapter_id)
        );

        let (scramble_id, chapter_resp_data) = match res {
            Ok(data) => data,
            Err(err) => {
                let err_title = "获取图片下载链接失败";
                let message = err.to_message();
                tracing::error!(err_title, message);

                self.set_state(DownloadTaskState::Failed);
                self.emit_download_task_update_event();

                return None;
            }
        };

        let urls_with_block_num: Vec<(String, u32)> = chapter_resp_data
            .images
            .into_iter()
            .filter_map(|filename| {
                let file_path = Path::new(&filename);
                let ext = file_path.extension()?.to_str()?.to_lowercase();
                let url = format!("https://{IMAGE_DOMAIN}/media/photos/{chapter_id}/{filename}");
                if ext == "gif" {
                    return Some((url, 0));
                } else if ext != "webp" {
                    return None;
                }

                let filename_without_ext = file_path.file_stem()?.to_str()?;
                let block_num = calculate_block_num(scramble_id, chapter_id, filename_without_ext);
                Some((url, block_num))
            })
            .collect();

        tracing::trace!("获取图片链接成功");

        Some(urls_with_block_num)
    }

    #[instrument(level = "error", skip_all, fields(temp_download_dir = %temp_download_dir.display()))]
    fn clean_temp_download_dir(&self, temp_download_dir: &Path) {
        let entries = match std::fs::read_dir(temp_download_dir).map_err(eyre::Report::from) {
            Ok(entries) => entries,
            Err(err) => {
                let err_title = "读取临时下载目录失败";
                let message = err.to_message();
                tracing::error!(err_title, message);
                return;
            }
        };

        let download_format = self.download_format;
        let extension = download_format.extension();
        for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
            let should_keep = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext == "gif" || ext == extension);
            if should_keep {
                continue;
            }

            if let Err(err) = std::fs::remove_file(&path).map_err(eyre::Report::from) {
                let err_title = "删除临时下载目录中的文件失败";
                let message = err.to_message();
                tracing::error!(err_title, message);
            }
        }

        tracing::trace!("清理临时下载目录成功");
    }

    #[instrument(level = "error", skip_all)]
    async fn acquire_chapter_permit<'a>(&'a self, permit: &mut Option<SemaphorePermit<'a>>) {
        tracing::debug!("章节开始排队");

        self.emit_download_task_update_event();

        *permit = match permit.take() {
            Some(permit) => Some(permit),
            None => match self
                .app
                .get_download_manager()
                .inner()
                .chapter_sem
                .acquire()
                .await
                .map_err(eyre::Report::from)
            {
                Ok(permit) => Some(permit),
                Err(err) => {
                    let err_title = "获取下载章节的permit失败";
                    let message = err.to_message();
                    tracing::error!(err_title, message);

                    self.set_state(DownloadTaskState::Failed);
                    self.emit_download_task_update_event();
                    return;
                }
            },
        };

        if *self.state_sender.borrow() != DownloadTaskState::Pending {
            return;
        }

        if let Err(err) = self.change_state(DownloadTaskState::Downloading) {
            let err_title = "发送状态`Downloading`失败";
            let message = err.to_message();
            tracing::error!(err_title, message);
            self.set_state(DownloadTaskState::Failed);
        }
    }

    #[instrument(level = "error", skip_all)]
    async fn handle_state_change<'a>(
        &'a self,
        permit: &mut Option<SemaphorePermit<'a>>,
        state_receiver: &mut watch::Receiver<DownloadTaskState>,
    ) {
        self.emit_download_task_update_event();

        let state = *state_receiver.borrow();
        if state == DownloadTaskState::Paused {
            sleep(Duration::from_millis(100)).await;
            tracing::debug!("下载任务已暂停");
        } else if state == DownloadTaskState::Failed {
            sleep(Duration::from_millis(100)).await;
        } else if state == DownloadTaskState::Cancelled {
            sleep(Duration::from_millis(100)).await;
            tracing::debug!("下载任务已取消");
        }

        release_permit_if_needed(state, permit);
    }

    #[instrument(level = "error", skip_all)]
    async fn handle_delete_receiver_change<'a>(&'a self, permit: &mut Option<SemaphorePermit<'a>>) {
        if permit.is_some() {
            sleep(Duration::from_millis(100)).await;
        }

        tracing::debug!("下载任务已删除");
    }

    #[instrument(level = "error", skip_all)]
    async fn sleep_between_chapter(&self) {
        let mut remaining_sec = self.app.get_config().read().chapter_download_interval_sec;
        while remaining_sec > 0 {
            let _ = DownloadEvent::Sleeping {
                chapter_id: self.chapter_info.chapter_id,
                remaining_sec,
            }
            .emit(&self.app);
            sleep(Duration::from_secs(1)).await;
            remaining_sec -= 1;
        }
    }

    #[instrument(
        level = "error",
        skip_all,
        fields(
            comic_id = self.comic.id,
            comic_title = self.comic.name,
            chapter_id = self.chapter_info.chapter_id,
            chapter_title = self.chapter_info.chapter_title,
            order = self.chapter_info.order
        )
    )]
    pub fn set_state(&self, state: DownloadTaskState) {
        if let Err(error) = self.change_state(state) {
            tracing::error!(err_title = "保存下载队列失败", message = %error);
            self.state_sender.send_replace(state);
        }
    }

    pub(super) fn change_state(&self, state: DownloadTaskState) -> eyre::Result<()> {
        let _guard = self.state_change.lock();
        self.queue.update(QueueCheckpoint {
            task_id: &self.task_id,
            chapter_id: self.chapter_info.chapter_id,
            state,
            total_img_count: self.total_img_count.load(Ordering::Relaxed),
        })?;
        self.state_sender.send_replace(state);
        Ok(())
    }

    /// 获取当前任务中已下载的图片信息(供阅读模式使用)
    pub fn get_downloaded_imgs(&self) -> eyre::Result<ChapterDownloadedImgs> {
        let state = *self.state_sender.borrow();
        let state_is_active = state.is_active();

        let temp_dir = self
            .chapter_info
            .get_temp_download_dir()
            .wrap_err("获取临时下载目录失败")?;
        let regular_dir = self
            .chapter_info
            .chapter_download_dir
            .clone()
            .ok_or_eyre("`chapter_download_dir`字段为`None`")?;

        let dir = if state_is_active {
            if temp_dir.exists() || !regular_dir.exists() {
                temp_dir
            } else {
                regular_dir
            }
        } else if regular_dir.exists() || !temp_dir.exists() {
            regular_dir
        } else {
            temp_dir
        };

        let downloaded_imgs = read_downloaded_imgs_from_dir(&dir, state_is_active)?;
        let total_img_count = self.total_img_count.load(Ordering::Relaxed);
        let total_img_count = if total_img_count == 0 && !state_is_active {
            downloaded_imgs.len() as u32
        } else {
            total_img_count
        };

        Ok(ChapterDownloadedImgs {
            download_dir: dir.to_string_lossy().to_string(),
            downloaded_imgs,
            total_img_count,
            is_downloading: state_is_active,
        })
    }

    pub fn emit_download_task_update_event(&self) {
        let _ = DownloadEvent::TaskUpdate {
            chapter_id: self.chapter_info.chapter_id,
            state: *self.state_sender.borrow(),
            downloaded_img_count: self.downloaded_img_count.load(Ordering::Relaxed),
            total_img_count: self.total_img_count.load(Ordering::Relaxed),
        }
        .emit(&self.app);
    }

    pub(super) fn emit_download_task_create_event(&self) {
        let _ = DownloadEvent::TaskCreate {
            state: *self.state_sender.borrow(),
            comic: Box::new(self.comic.as_ref().clone()),
            chapter_info: Box::new(self.chapter_info.as_ref().clone()),
            downloaded_img_count: self.downloaded_img_count.load(Ordering::Relaxed),
            total_img_count: self.total_img_count.load(Ordering::Relaxed),
        }
        .emit(&self.app);
    }
}

/// 任务进入`Paused`/`Failed`/`Cancelled`状态时，需要释放持有中的章节下载permit
///
/// 不释放的话，其他章节就再也拿不到permit(表现为所有章节都卡在`排队中`)
fn release_permit_if_needed<'a>(
    state: DownloadTaskState,
    permit: &mut Option<SemaphorePermit<'a>>,
) {
    let should_release = match state {
        DownloadTaskState::Paused | DownloadTaskState::Failed | DownloadTaskState::Cancelled => {
            true
        }
        DownloadTaskState::Pending
        | DownloadTaskState::Downloading
        | DownloadTaskState::Completed => false,
    };

    if should_release {
        if let Some(permit) = permit.take() {
            drop(permit);
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::Semaphore;

    use super::{release_permit_if_needed, DownloadTaskState};

    /// 模拟`process()`中的章节permit: 任务下载时持有permit
    fn acquire_permit<'a>(semaphore: &'a Semaphore) -> tokio::sync::SemaphorePermit<'a> {
        semaphore.try_acquire().expect("应该能拿到permit")
    }

    #[tokio::test]
    async fn cancelled_task_releases_the_chapter_permit() {
        // 回归测试: 取消下载的任务必须释放章节permit，
        // 否则被取消的任务会永久占用一个下载槽位，其他章节全部卡在`排队中`
        let semaphore = Semaphore::new(1);
        let mut permit = Some(acquire_permit(&semaphore));

        release_permit_if_needed(DownloadTaskState::Cancelled, &mut permit);

        assert!(permit.is_none(), "取消任务后应该释放permit");
        assert!(
            semaphore.try_acquire().is_ok(),
            "取消任务后其他章节应该能拿到permit"
        );
    }

    #[tokio::test]
    async fn failed_task_releases_the_chapter_permit() {
        let semaphore = Semaphore::new(1);
        let mut permit = Some(acquire_permit(&semaphore));

        release_permit_if_needed(DownloadTaskState::Failed, &mut permit);

        assert!(permit.is_none());
        assert!(semaphore.try_acquire().is_ok());
    }

    #[tokio::test]
    async fn paused_task_releases_the_chapter_permit() {
        let semaphore = Semaphore::new(1);
        let mut permit = Some(acquire_permit(&semaphore));

        release_permit_if_needed(DownloadTaskState::Paused, &mut permit);

        assert!(permit.is_none());
        assert!(semaphore.try_acquire().is_ok());
    }

    #[tokio::test]
    async fn downloading_task_keeps_the_chapter_permit() {
        let semaphore = Semaphore::new(1);
        let mut permit = Some(acquire_permit(&semaphore));

        release_permit_if_needed(DownloadTaskState::Downloading, &mut permit);

        assert!(permit.is_some(), "下载中的任务不能释放permit");
        assert!(
            semaphore.try_acquire().is_err(),
            "下载中的任务应该继续占用permit"
        );
    }
}
