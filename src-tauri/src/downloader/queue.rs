use std::{collections::BTreeMap, fs::File, io::Write, path::PathBuf};

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
}

impl DownloadQueue {
    pub fn open(path: PathBuf) -> eyre::Result<Self> {
        let tasks = match std::fs::read(&path) {
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
        Ok(Self {
            path,
            tasks: Mutex::new(tasks),
        })
    }

    pub fn entries(&self) -> Vec<QueuedDownload> {
        self.tasks.lock().values().cloned().collect()
    }

    pub fn insert(&self, task: QueuedDownload) -> eyre::Result<()> {
        let mut tasks = self.tasks.lock();
        let mut next = tasks.clone();
        next.insert(task.chapter_id, task);
        self.save(&next)?;
        *tasks = next;
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
        Ok(())
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
