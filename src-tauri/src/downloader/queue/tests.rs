use super::*;
use crate::types::ChapterInfo;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("jmcomic-queue-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn path(&self) -> PathBuf {
        self.0.join("queue.json")
    }
    fn task(&self, id: i64, state: DownloadTaskState) -> QueuedDownload {
        QueuedDownload {
            task_id: uuid::Uuid::new_v4().to_string(),
            chapter_id: id,
            state,
            root: self.0.join("original-downloads"),
            format: DownloadFormat::Png,
            total_img_count: 12,
            comic: Comic {
                id: 10,
                name: "Fixture comic".into(),
                comic_download_dir: Some(self.0.join("original-downloads/comic")),
                chapter_infos: vec![ChapterInfo {
                    chapter_id: id,
                    chapter_title: "Chapter".into(),
                    chapter_download_dir: Some(
                        self.0.join(format!("original-downloads/comic/{id}")),
                    ),
                    ..ChapterInfo::default()
                }],
                ..Comic::default()
            },
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn restart_preserves_paused_failed_tasks_paths_and_format() {
    let fixture = Fixture::new();
    let states = [
        DownloadTaskState::Downloading,
        DownloadTaskState::Paused,
        DownloadTaskState::Failed,
    ];
    let queue = DownloadQueue::open(fixture.path()).unwrap();
    for (index, state) in states.into_iter().enumerate() {
        queue
            .insert(fixture.task(i64::try_from(index).unwrap() + 1, state))
            .unwrap();
    }
    drop(queue);

    let restored = DownloadQueue::open(fixture.path()).unwrap().entries();

    assert_eq!(restored.len(), 3);
    assert_eq!(
        restored[0].restored_state(),
        Some(DownloadTaskState::Pending)
    );
    assert_eq!(
        restored[1].restored_state(),
        Some(DownloadTaskState::Paused)
    );
    assert_eq!(
        restored[2].restored_state(),
        Some(DownloadTaskState::Failed)
    );
    assert_eq!(restored[0].root, fixture.0.join("original-downloads"));
    assert_eq!(restored[0].format, DownloadFormat::Png);
    assert_eq!(restored[0].total_img_count, 12);
    assert_eq!(
        restored[0].comic.chapter_infos[0].chapter_download_dir,
        Some(fixture.0.join("original-downloads/comic/1"))
    );
}

#[test]
fn finished_or_cancelled_tasks_do_not_return_after_restart() {
    let fixture = Fixture::new();
    let queue = DownloadQueue::open(fixture.path()).unwrap();
    for (id, state) in [
        (1, DownloadTaskState::Completed),
        (2, DownloadTaskState::Cancelled),
    ] {
        let task = fixture.task(id, DownloadTaskState::Pending);
        queue.insert(task.clone()).unwrap();
        queue
            .update(QueueCheckpoint {
                task_id: &task.task_id,
                chapter_id: id,
                state,
                total_img_count: 12,
            })
            .unwrap();
    }
    assert!(DownloadQueue::open(fixture.path())
        .unwrap()
        .entries()
        .is_empty());
}

#[test]
fn late_checkpoint_cannot_remove_a_replacement_task() {
    let fixture = Fixture::new();
    let queue = DownloadQueue::open(fixture.path()).unwrap();
    let old = fixture.task(1, DownloadTaskState::Failed);
    let replacement = fixture.task(1, DownloadTaskState::Pending);
    queue.insert(old.clone()).unwrap();
    queue.insert(replacement.clone()).unwrap();

    queue
        .update(QueueCheckpoint {
            task_id: &old.task_id,
            chapter_id: 1,
            state: DownloadTaskState::Completed,
            total_img_count: 12,
        })
        .unwrap();

    assert_eq!(
        DownloadQueue::open(fixture.path()).unwrap().entries()[0].task_id,
        replacement.task_id
    );
}

#[test]
fn invalid_queue_is_reported_without_overwriting_it() {
    let fixture = Fixture::new();
    std::fs::write(fixture.path(), "interrupted or invalid JSON").unwrap();
    assert!(DownloadQueue::open(fixture.path()).is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.path()).unwrap(),
        "interrupted or invalid JSON"
    );
}

#[test]
fn failed_save_leaves_memory_and_previous_file_unchanged() {
    let fixture = Fixture::new();
    let queue = DownloadQueue::open(fixture.path()).unwrap();
    let task = fixture.task(1, DownloadTaskState::Paused);
    queue.insert(task.clone()).unwrap();
    let previous = fixture.0.join("previous.json");
    std::fs::rename(fixture.path(), &previous).unwrap();
    std::fs::create_dir(fixture.path()).unwrap();

    assert!(queue
        .update(QueueCheckpoint {
            task_id: &task.task_id,
            chapter_id: 1,
            state: DownloadTaskState::Pending,
            total_img_count: 12
        })
        .is_err());

    assert_eq!(queue.entries()[0].state, DownloadTaskState::Paused);
    assert_eq!(
        DownloadQueue::open(previous).unwrap().entries()[0].state,
        DownloadTaskState::Paused
    );
    assert!(!std::fs::read_dir(&fixture.0).unwrap().any(|entry| entry
        .unwrap()
        .path()
        .extension()
        .is_some_and(|extension| extension == "tmp")));
}
