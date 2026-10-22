use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use eyre::{eyre, OptionExt, WrapErr};
use parking_lot::RwLock;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::sync::{Mutex, OwnedMutexGuard, Semaphore};
use tracing::instrument;

use super::queue::DownloadQueue;
use crate::{
    config::Config,
    downloader::{download_task::DownloadTask, download_task_state::DownloadTaskState},
    events::DownloadEvent,
    extensions::{EyreReportToMessage, PathIsImg},
    types::Comic,
};

/// 章节中已下载的图片信息(供阅读模式使用)
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChapterDownloadedImgs {
    pub download_dir: String,
    pub downloaded_imgs: Vec<String>,
    pub total_img_count: u32,
    pub is_downloading: bool,
}

/// 被删除的下载任务的相关目录信息(用于清理下载产物)
pub struct RemovedDownloadTask {
    pub task: Arc<DownloadTask>,
    _deletion_guard: OwnedMutexGuard<()>,
    pub download_dir: PathBuf,
    pub comic_download_dir: PathBuf,
    pub chapter_download_dir: PathBuf,
    pub temp_download_dir: PathBuf,
}

pub struct DownloadManager {
    pub cleanup_gate: Arc<Mutex<()>>,
    pub app: AppHandle,
    pub chapter_sem: Arc<Semaphore>,
    pub img_sem: Arc<Semaphore>,
    pub byte_per_sec: Arc<AtomicU64>,
    pub download_tasks: RwLock<HashMap<i64, Arc<DownloadTask>>>,
    queue: Result<Arc<DownloadQueue>, String>,
    restored: parking_lot::Mutex<bool>,
}

impl DownloadManager {
    pub fn new(app: &AppHandle, app_data_dir: &Path) -> Self {
        let (chapter_concurrency, img_concurrency) = {
            let config = app.state::<RwLock<Config>>();
            let config = config.read();
            (config.chapter_concurrency, config.img_concurrency)
        };

        let manager = DownloadManager {
            cleanup_gate: Arc::new(Mutex::new(())),
            app: app.clone(),
            chapter_sem: Arc::new(Semaphore::new(chapter_concurrency)),
            img_sem: Arc::new(Semaphore::new(img_concurrency)),
            byte_per_sec: Arc::new(AtomicU64::new(0)),
            download_tasks: RwLock::new(HashMap::new()),
            queue: DownloadQueue::open(app_data_dir.join("download-queue.json"))
                .map(Arc::new)
                .map_err(|error| format!("{error:?}")),
            restored: parking_lot::Mutex::new(false),
        };

        tauri::async_runtime::spawn(Self::emit_download_speed_loop(
            manager.app.clone(),
            manager.byte_per_sec.clone(),
        ));

        manager
    }

    pub(super) fn queue(&self) -> eyre::Result<&Arc<DownloadQueue>> {
        self.queue.as_ref().map_err(|error| eyre!("{error}"))
    }

    pub fn restore_download_queue(&self) -> eyre::Result<()> {
        let mut restored = self.restored.lock();
        let queue = self.queue()?;
        let mut tasks = self.download_tasks.write();
        let mut errors = Vec::new();
        if !*restored {
            for mut entry in queue.entries() {
                if tasks.contains_key(&entry.chapter_id) {
                    continue;
                }
                let Some(state) = entry.restored_state() else {
                    continue;
                };
                entry.state = state;
                let chapter_id = entry.chapter_id;
                match DownloadTask::from_queue(self.app.clone(), entry) {
                    Ok(task) => {
                        tasks.insert(chapter_id, task);
                    }
                    Err(error) => errors.push(format!("章节 {chapter_id}: {error:?}")),
                }
            }
            *restored = errors.is_empty();
        }
        for task in tasks.values() {
            task.emit_download_task_create_event();
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(eyre!("部分下载任务恢复失败：{}", errors.join("；")))
        }
    }

    #[instrument(
        level = "error",
        skip_all,
        fields(comic_id = comic.id, comic_title = comic.name)
    )]
    pub fn create_download_tasks(&self, mut comic: Comic, chapter_ids: &[i64]) {
        let Ok(_cleanup_guard) = self.cleanup_gate.try_lock() else {
            tracing::error!("下载产物正在清理，请稍后重试创建下载任务");
            return;
        };
        if let Err(err) = comic.ensure_download_dir_fields(&self.app) {
            let err_title = "批量创建下载任务失败";
            let message = err.to_message();
            tracing::error!(err_title, message);
            return;
        }

        let mut tasks = self.download_tasks.write();
        for chapter_id in chapter_ids {
            let span = tracing::error_span!("create_download_task", chapter_id = chapter_id);
            let _enter = span.enter();

            if let Some(task) = tasks.get(chapter_id) {
                if task.is_busy() {
                    let err_title = "章节ID对应的下载任务创建失败";
                    let message = eyre!("章节ID对应的下载任务已存在").to_message();
                    tracing::error!(err_title, message);
                    continue;
                }
            }

            if let Some(task) = tasks.remove(chapter_id) {
                task.delete_sender.send_replace(());
            }

            let task = match DownloadTask::new(self.app.clone(), comic.clone(), *chapter_id) {
                Ok(task) => task,
                Err(err) => {
                    let err_title = "章节ID对应的下载任务创建失败";
                    let message = err.to_message();
                    tracing::error!(err_title, message);
                    continue;
                }
            };

            tasks.insert(*chapter_id, task);
        }
    }

    async fn emit_download_speed_loop(app: AppHandle, byte_per_sec: Arc<AtomicU64>) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));

        loop {
            interval.tick().await;
            let byte_per_sec = byte_per_sec.swap(0, Ordering::Relaxed);
            #[allow(clippy::cast_precision_loss)]
            let mega_byte_per_sec = byte_per_sec as f64 / 1024.0 / 1024.0;
            let speed = format!("{mega_byte_per_sec:.2}MB/s");
            let _ = DownloadEvent::Speed { speed }.emit(&app);
        }
    }

    #[instrument(
        level = "error",
        skip_all,
        fields(
            comic_id = comic.id,
            comic_title = comic.name,
            chapter_id = chapter_id
        )
    )]
    pub fn create_download_task(&self, comic: Comic, chapter_id: i64) -> eyre::Result<()> {
        let _cleanup_guard = self
            .cleanup_gate
            .try_lock()
            .wrap_err("下载产物正在清理，请稍后重试")?;
        let mut tasks = self.download_tasks.write();

        if let Some(task) = tasks.get(&chapter_id) {
            if task.is_busy() {
                return Err(eyre!("章节ID为`{chapter_id}`的下载任务已存在"));
            }
        }

        if let Some(task) = tasks.remove(&chapter_id) {
            task.delete_sender.send_replace(());
        }

        let task = DownloadTask::new(self.app.clone(), comic, chapter_id)
            .wrap_err("DownloadTask创建失败")?;

        tasks.insert(chapter_id, task);

        Ok(())
    }

    #[instrument(level = "error", skip_all, fields(chapter_id = chapter_id))]
    pub fn pause_download_task(&self, chapter_id: i64) -> eyre::Result<()> {
        let tasks = self.download_tasks.read();
        let Some(task) = tasks.get(&chapter_id) else {
            return Err(eyre!("未找到章节ID为`{chapter_id}`的下载任务"));
        };
        task.change_state(DownloadTaskState::Paused)?;
        Ok(())
    }

    #[instrument(level = "error", skip_all, fields(chapter_id = chapter_id))]
    pub fn resume_download_task(&self, chapter_id: i64) -> eyre::Result<()> {
        let tasks = self.download_tasks.read();
        let Some(task) = tasks.get(&chapter_id) else {
            return Err(eyre!("未找到章节ID为`{chapter_id}`的下载任务"));
        };
        let _deletion_guard = task.deletion_lock.try_lock().wrap_err("下载任务正在删除")?;
        if task.process_finished() {
            return Err(eyre!("下载任务已取消，请重新创建下载任务"));
        }
        task.change_state(DownloadTaskState::Pending)?;
        Ok(())
    }

    #[instrument(level = "error", skip_all, fields(chapter_id = chapter_id))]
    pub fn delete_download_task(&self, chapter_id: i64) -> eyre::Result<RemovedDownloadTask> {
        let tasks = self.download_tasks.read();
        let task = tasks
            .get(&chapter_id)
            .ok_or_eyre(format!("未找到章节ID为`{chapter_id}`的下载任务"))?;
        let deletion_guard = task
            .deletion_lock
            .clone()
            .try_lock_owned()
            .wrap_err("下载任务正在删除")?;
        task.paths.validate()?;
        task.change_state(DownloadTaskState::Cancelled)?;
        task.delete_sender.send_replace(());

        Ok(RemovedDownloadTask {
            task: task.clone(),
            _deletion_guard: deletion_guard,
            download_dir: task.paths.root.clone(),
            comic_download_dir: task.paths.comic.clone(),
            chapter_download_dir: task.paths.chapter.clone(),
            temp_download_dir: task.paths.temporary.clone(),
        })
    }

    /// 判断是否存在属于`comic_download_dir`的漫画且仍在进行中的下载任务
    #[instrument(level = "error", skip_all)]
    pub fn has_active_tasks_of_comic(
        &self,
        comic_download_dir: &Path,
        except_chapter: i64,
    ) -> bool {
        let tasks = self.download_tasks.read();
        tasks.values().any(|task| {
            if task.chapter_info.chapter_id == except_chapter
                || task.paths.comic != comic_download_dir
            {
                return false;
            }
            task.is_busy()
        })
    }

    pub fn complete_delete_download_task(&self, chapter_id: i64) {
        self.download_tasks.write().remove(&chapter_id);
        let _ = DownloadEvent::TaskDelete { chapter_id }.emit(&self.app);
    }

    pub fn chapter_ids_of_comic(&self, comic_dir: &Path) -> Vec<i64> {
        self.download_tasks
            .read()
            .iter()
            .filter(|(_, task)| task.paths.comic == comic_dir)
            .map(|(id, _)| *id)
            .collect()
    }

    /// 取消下载任务(保留已下载的文件)
    #[instrument(level = "error", skip_all, fields(chapter_id = chapter_id))]
    pub fn cancel_download_task(&self, chapter_id: i64) -> eyre::Result<()> {
        let tasks = self.download_tasks.read();
        let Some(task) = tasks.get(&chapter_id) else {
            return Err(eyre!("未找到章节ID为`{chapter_id}`的下载任务"));
        };
        task.change_state(DownloadTaskState::Cancelled)?;
        Ok(())
    }

    /// 获取章节中已下载的图片信息
    #[instrument(level = "error", skip_all, fields(chapter_id = chapter_id))]
    pub fn get_chapter_downloaded_imgs(
        &self,
        comic: &Comic,
        chapter_id: i64,
    ) -> eyre::Result<ChapterDownloadedImgs> {
        let tasks = self.download_tasks.read();
        if let Some(task) = tasks.get(&chapter_id) {
            return task.get_downloaded_imgs();
        }
        drop(tasks);

        let chapter_info = comic
            .chapter_infos
            .iter()
            .find(|chapter| chapter.chapter_id == chapter_id)
            .ok_or_eyre(format!("未找到章节ID为`{chapter_id}`的章节信息"))?;

        let chapter_download_dir = chapter_info
            .chapter_download_dir
            .as_ref()
            .ok_or_eyre("`chapter_download_dir`字段为`None`，章节可能尚未下载")?;

        let downloaded_imgs = read_downloaded_imgs_from_dir(chapter_download_dir, false)?;
        let total_img_count = downloaded_imgs.len() as u32;

        Ok(ChapterDownloadedImgs {
            download_dir: chapter_download_dir.to_string_lossy().to_string(),
            downloaded_imgs,
            total_img_count,
            is_downloading: false,
        })
    }
}

/// 读取`dir`目录中已下载的图片文件名(按文件名中的数字序号排序)
pub fn read_downloaded_imgs_from_dir(
    dir: &std::path::Path,
    allow_missing: bool,
) -> eyre::Result<Vec<String>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if allow_missing && err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Vec::new());
        }
        Err(err) => {
            return Err(
                eyre::Report::from(err).wrap_err(format!("读取目录`{}`失败", dir.display()))
            );
        }
    };

    let mut filenames = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_img())
        .filter_map(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();

    filenames.sort_by_key(|filename| {
        std::path::Path::new(filename.as_str())
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.parse::<u32>().ok())
            .unwrap_or(u32::MAX)
    });

    Ok(filenames)
}
