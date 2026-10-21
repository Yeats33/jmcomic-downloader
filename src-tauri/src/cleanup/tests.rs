use std::path::{Path, PathBuf};

use super::{ensure_strictly_inside, remove_comic_dir_if_no_chapters, remove_dir_inside};

/// 系统临时目录中唯一的测试目录，drop时删除
struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("jmcomic-cleanup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn mkdir(&self, relative: &str) -> PathBuf {
        let dir = self.0.join(relative);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(&self, relative: &str) {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "{}").unwrap();
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn assert_rejected(path: &Path, root: &Path) {
    assert!(
        ensure_strictly_inside(path, root).is_err(),
        "`{}` should be rejected",
        path.display()
    );
}

#[test]
fn dir_inside_root_is_accepted() {
    let test_dir = TestDir::new();
    let download_dir = test_dir.mkdir("download");
    let comic_dir = test_dir.mkdir("download/author/comic");

    assert!(ensure_strictly_inside(&comic_dir, &download_dir).is_ok());
}

#[test]
fn root_itself_is_rejected() {
    let test_dir = TestDir::new();
    let download_dir = test_dir.mkdir("download");
    let comic_dir = test_dir.mkdir("download/comic");

    assert_rejected(&download_dir, &download_dir);
    assert_rejected(&comic_dir.join(".."), &download_dir);
}

#[test]
fn dir_outside_root_is_rejected() {
    let test_dir = TestDir::new();
    let download_dir = test_dir.mkdir("download");
    let sibling_dir = test_dir.mkdir("download-other");

    assert_rejected(&sibling_dir, &download_dir);
    assert_rejected(&test_dir.0, &download_dir);
}

#[test]
fn parent_dir_traversal_is_rejected() {
    let test_dir = TestDir::new();
    let download_dir = test_dir.mkdir("download");
    test_dir.mkdir("other");

    assert_rejected(&download_dir.join("..").join("other"), &download_dir);
}

#[cfg(unix)]
#[tokio::test]
async fn intermediate_symlink_cannot_delete_outside_root() {
    let test_dir = TestDir::new();
    let root = test_dir.mkdir("download");
    let outside = test_dir.mkdir("outside");
    let victim = test_dir.mkdir("outside/victim");
    test_dir.touch("outside/victim/keep.txt");
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

    let result = remove_dir_inside(&root.join("link/victim"), &root).await;

    assert!(result.is_err());
    assert!(victim.join("keep.txt").exists());
}

#[cfg(unix)]
#[test]
fn symlink_to_root_is_rejected() {
    let test_dir = TestDir::new();
    let root = test_dir.mkdir("download");
    std::os::unix::fs::symlink(&root, root.join("root-alias")).unwrap();

    assert_rejected(&root.join("root-alias"), &root);
}

#[cfg(unix)]
#[tokio::test]
async fn configured_symlink_root_allows_normal_cleanup() {
    let test_dir = TestDir::new();
    let actual_root = test_dir.mkdir("actual");
    test_dir.mkdir("actual/comic/chapter");
    let root = test_dir.0.join("download");
    std::os::unix::fs::symlink(&actual_root, &root).unwrap();

    remove_dir_inside(&root.join("comic/chapter"), &root)
        .await
        .unwrap();

    assert!(!actual_root.join("comic/chapter").exists());
    assert!(actual_root.join("comic").exists());
}

#[tokio::test]
async fn missing_download_root_is_a_noop() {
    let test_dir = TestDir::new();
    let root = test_dir.0.join("not-created-yet");

    remove_dir_inside(&root.join("comic/chapter"), &root)
        .await
        .unwrap();

    assert!(!root.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn comic_cleanup_rejects_an_intermediate_symlink() {
    let test_dir = TestDir::new();
    let root = test_dir.mkdir("download");
    let outside = test_dir.mkdir("outside");
    let victim = test_dir.mkdir("outside/comic");
    test_dir.touch("outside/comic/keep.txt");
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

    let result = remove_comic_dir_if_no_chapters(&root.join("link/comic"), &root).await;

    assert!(result.is_err());
    assert!(victim.join("keep.txt").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn leaf_symlink_cleanup_preserves_its_internal_target() {
    let test_dir = TestDir::new();
    let root = test_dir.mkdir("download");
    let target = test_dir.mkdir("download/target");
    test_dir.touch("download/target/keep.txt");
    let link = root.join("comic");
    std::os::unix::fs::symlink(&target, &link).unwrap();

    remove_dir_inside(&link, &root).await.unwrap();

    assert!(target.join("keep.txt").exists());
    assert!(std::fs::symlink_metadata(link).is_err());
}

#[cfg(unix)]
#[test]
fn missing_target_under_an_external_symlink_is_rejected() {
    let test_dir = TestDir::new();
    let root = test_dir.mkdir("download");
    let outside = test_dir.mkdir("outside");
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

    assert_rejected(&root.join("link/not-created/chapter"), &root);
}

#[tokio::test]
async fn remove_dir_inside_removes_dir_and_contents() {
    let test_dir = TestDir::new();
    let download_dir = test_dir.mkdir("download");
    let chapter_dir = test_dir.mkdir("download/comic/chapter");
    test_dir.touch("download/comic/chapter/0001.webp");

    remove_dir_inside(&chapter_dir, &download_dir)
        .await
        .unwrap();

    assert!(!chapter_dir.exists());
    assert!(download_dir.join("comic").exists());
}

#[tokio::test]
async fn remove_dir_inside_ignores_missing_dir() {
    let test_dir = TestDir::new();
    let download_dir = test_dir.mkdir("download");

    remove_dir_inside(&download_dir.join("missing"), &download_dir)
        .await
        .unwrap();
}

#[tokio::test]
async fn remove_dir_inside_refuses_dir_outside_root() {
    let test_dir = TestDir::new();
    let download_dir = test_dir.mkdir("download");
    let other_dir = test_dir.mkdir("other");

    assert!(remove_dir_inside(&other_dir, &download_dir).await.is_err());
    assert!(remove_dir_inside(&download_dir, &download_dir)
        .await
        .is_err());

    assert!(other_dir.exists());
    assert!(download_dir.exists());
}

#[tokio::test]
async fn comic_dir_with_downloaded_chapter_is_kept() {
    let test_dir = TestDir::new();
    let download_dir = test_dir.mkdir("download");
    let comic_dir = test_dir.mkdir("download/comic");
    test_dir.touch("download/comic/元数据.json");
    test_dir.touch("download/comic/chapter/章节元数据.json");

    remove_comic_dir_if_no_chapters(&comic_dir, &download_dir)
        .await
        .unwrap();

    assert!(comic_dir.exists());
}

#[tokio::test]
async fn comic_dir_without_downloaded_chapters_is_removed() {
    let test_dir = TestDir::new();
    let download_dir = test_dir.mkdir("download");
    let comic_dir = test_dir.mkdir("download/comic");
    test_dir.touch("download/comic/元数据.json");
    test_dir.mkdir("download/comic/.下载中-chapter");

    remove_comic_dir_if_no_chapters(&comic_dir, &download_dir)
        .await
        .unwrap();

    assert!(!comic_dir.exists());
    assert!(download_dir.exists());
}
