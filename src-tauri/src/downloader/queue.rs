use std::{collections::BTreeMap, fs::File, io::Write, path::PathBuf, sync::Arc};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};

use eyre::{eyre, WrapErr};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::types::{Comic, DownloadFormat};

use super::download_task_state::DownloadTaskState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedDownload {
    pub task_id: String,
    pub comic: Comic,
    pub chapter_id: i64,
    pub root: PathBuf,
    pub format: DownloadFormat,
    pub state: DownloadTaskState,
    pub total_img_count: u32,
    #[serde(default)]
    pub position: u64,
    /// 本次运行中已有对应的下载任务(由`insert`设置)。
    /// 尚未恢复或恢复失败的条目不参与调度，否则会让排在后面的任务永远等待。
    #[serde(skip)]
    pub attached: bool,
}

pub struct QueueCheckpoint<'a> {
    pub task_id: &'a str,
    pub chapter_id: i64,
    pub state: DownloadTaskState,
    pub total_img_count: u32,
}

impl QueuedDownload {
    pub fn restored_state(&self) -> Option<DownloadTaskState> {
        match self.state {
            DownloadTaskState::Pending | DownloadTaskState::Downloading => {
                Some(DownloadTaskState::Pending)
            }
            DownloadTaskState::Paused => Some(DownloadTaskState::Paused),
            DownloadTaskState::Failed => Some(DownloadTaskState::Failed),
            DownloadTaskState::Cancelled | DownloadTaskState::Completed => None,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct QueueFile {
    version: u32,
    tasks: BTreeMap<i64, QueuedDownload>,
}

pub struct DownloadQueue {
    path: PathBuf,
    tasks: Mutex<BTreeMap<i64, QueuedDownload>>,
    changed: watch::Sender<()>,
}

impl DownloadQueue {
    pub fn open(path: PathBuf) -> eyre::Result<Self> {
        let mut tasks = match std::fs::read(&path) {
            Ok(bytes) => {
                let saved: QueueFile =
                    serde_json::from_slice(&bytes).wrap_err("下载队列文件损坏，原文件已保留")?;
                if saved.version != 1 {
                    return Err(eyre!("下载队列版本不受支持，原文件已保留"));
                }
                if saved
                    .tasks
                    .iter()
                    .any(|(id, task)| *id != task.chapter_id || !task.root.is_absolute())
                {
                    return Err(eyre!("下载队列包含无效任务，原文件已保留"));
                }
                saved.tasks
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error.into()),
        };
        let mut position = tasks.values().map(|task| task.position).max().unwrap_or(0);
        for task in tasks.values_mut().filter(|task| task.position == 0) {
            position = position
                .checked_add(1)
                .ok_or_else(|| eyre!("下载队列顺序溢出"))?;
            task.position = position;
        }
        Ok(Self {
            path,
            tasks: Mutex::new(tasks),
            changed: watch::channel(()).0,
        })
    }

    pub fn entries(&self) -> Vec<QueuedDownload> {
        let mut tasks: Vec<_> = self.tasks.lock().values().cloned().collect();
        tasks.sort_by_key(|task| (task.position, task.chapter_id));
        tasks
    }

    pub fn insert(&self, mut task: QueuedDownload) -> eyre::Result<()> {
        let mut tasks = self.tasks.lock();
        task.attached = true;
        if task.position == 0 {
            task.position = tasks
                .values()
                .map(|entry| entry.position)
                .max()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| eyre!("下载队列顺序溢出"))?;
        }
        let mut next = tasks.clone();
        next.insert(task.chapter_id, task);
        self.save(&next)?;
        *tasks = next;
        self.changed.send_replace(());
        Ok(())
    }

    pub fn update(&self, checkpoint: QueueCheckpoint<'_>) -> eyre::Result<()> {
        let mut tasks = self.tasks.lock();
        if !tasks
            .get(&checkpoint.chapter_id)
            .is_some_and(|task| task.task_id == checkpoint.task_id)
        {
            return Ok(());
        }
        let mut next = tasks.clone();
        match checkpoint.state {
            DownloadTaskState::Cancelled | DownloadTaskState::Completed => {
                next.remove(&checkpoint.chapter_id);
            }
            DownloadTaskState::Pending
            | DownloadTaskState::Downloading
            | DownloadTaskState::Paused
            | DownloadTaskState::Failed => {
                if let Some(task) = next.get_mut(&checkpoint.chapter_id) {
                    task.state = checkpoint.state;
                    task.total_img_count = checkpoint.total_img_count;
                }
            }
        }
        self.save(&next)?;
        *tasks = next;
        self.changed.send_replace(());
        Ok(())
    }

    pub fn prioritize(&self, chapter_id: i64) -> eyre::Result<()> {
        let mut tasks = self.tasks.lock();
        if !tasks.contains_key(&chapter_id) {
            return Err(eyre!("下载任务已结束或不存在"));
        }
        let mut ordered: Vec<_> = tasks.values().cloned().collect();
        ordered.sort_by_key(|task| {
            (
                task.chapter_id != chapter_id,
                task.position,
                task.chapter_id,
            )
        });
        let mut next = BTreeMap::new();
        for (index, mut task) in ordered.into_iter().enumerate() {
            task.position = u64::try_from(index)?
                .checked_add(1)
                .ok_or_else(|| eyre!("下载队列顺序溢出"))?;
            next.insert(task.chapter_id, task);
        }
        self.save(&next)?;
        *tasks = next;
        self.changed.send_replace(());
        Ok(())
    }

    fn next_pending(tasks: &BTreeMap<i64, QueuedDownload>) -> Option<&QueuedDownload> {
        tasks
            .values()
            .filter(|task| task.attached && task.state == DownloadTaskState::Pending)
            .min_by_key(|task| (task.position, task.chapter_id))
    }

    fn claim(&self, chapter_id: i64, task_id: &str) -> eyre::Result<bool> {
        let mut tasks = self.tasks.lock();
        if !Self::next_pending(&tasks)
            .is_some_and(|task| task.chapter_id == chapter_id && task.task_id == task_id)
        {
            return Ok(false);
        }
        let mut next = tasks.clone();
        if let Some(task) = next.get_mut(&chapter_id) {
            task.state = DownloadTaskState::Downloading;
        }
        self.save(&next)?;
        *tasks = next;
        self.changed.send_replace(());
        Ok(true)
    }

    pub async fn acquire(
        &self,
        chapter_id: i64,
        task_id: &str,
        slots: Arc<Semaphore>,
    ) -> eyre::Result<OwnedSemaphorePermit> {
        let mut changed = self.changed.subscribe();
        loop {
            let first = Self::next_pending(&self.tasks.lock())
                .is_some_and(|task| task.chapter_id == chapter_id && task.task_id == task_id);
            if first {
                tokio::select! {
                    permit = Arc::clone(&slots).acquire_owned() => {
                        let permit = permit.wrap_err("下载调度已关闭")?;
                        if self.claim(chapter_id, task_id)? { return Ok(permit); }
                    }
                    result = changed.changed() => { result.wrap_err("下载队列已关闭")?; }
                }
            } else {
                changed.changed().await.wrap_err("下载队列已关闭")?;
            }
        }
    }

    fn save(&self, tasks: &BTreeMap<i64, QueuedDownload>) -> eyre::Result<()> {
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> eyre::Result<()> {
            let mut file = File::options()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            serde_json::to_writer(
                &mut file,
                &QueueFile {
                    version: 1,
                    tasks: tasks.clone(),
                },
            )?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &self.path).wrap_err("替换下载队列文件失败")?;
            Ok(())
        })();
        if result.is_err() {
            if let Err(error) = std::fs::remove_file(&temporary) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(%error, "清理队列临时文件失败");
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests;
