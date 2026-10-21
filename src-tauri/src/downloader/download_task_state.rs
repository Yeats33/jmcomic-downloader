use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum DownloadTaskState {
    Pending,
    Downloading,
    Paused,
    Cancelled,
    Completed,
    Failed,
}

impl DownloadTaskState {
    /// 该状态下任务已结束(不会再写入任何文件)
    pub fn is_finished(&self) -> bool {
        matches!(
            self,
            DownloadTaskState::Cancelled | DownloadTaskState::Completed | DownloadTaskState::Failed
        )
    }

    /// 该状态下任务仍会继续写入文件
    pub fn is_active(&self) -> bool {
        !self.is_finished()
    }
}

#[cfg(test)]
mod tests {
    use super::DownloadTaskState;

    #[test]
    fn cancelled_task_is_finished() {
        // 取消的任务不会再写入文件
        assert!(DownloadTaskState::Cancelled.is_finished());
        assert!(!DownloadTaskState::Cancelled.is_active());
    }

    #[test]
    fn completed_and_failed_tasks_are_finished() {
        assert!(DownloadTaskState::Completed.is_finished());
        assert!(DownloadTaskState::Failed.is_finished());
    }

    #[test]
    fn pending_downloading_paused_tasks_are_active() {
        // 这三种状态的任务仍会写入文件，删除漫画目录时必须保留
        assert!(DownloadTaskState::Pending.is_active());
        assert!(DownloadTaskState::Downloading.is_active());
        assert!(DownloadTaskState::Paused.is_active());
    }
}
