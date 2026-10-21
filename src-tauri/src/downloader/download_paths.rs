use std::path::{Path, PathBuf};

use eyre::OptionExt;

use crate::{
    cleanup,
    types::{ChapterInfo, Comic},
};

/// 创建任务时保存已验证的实际路径，后续配置修改不改变它的清理权限。
pub struct DownloadPaths {
    pub root: PathBuf,
    pub comic: PathBuf,
    pub chapter: PathBuf,
    pub temporary: PathBuf,
}

impl DownloadPaths {
    pub fn new(root: &Path, comic: &Comic, chapter: &ChapterInfo) -> eyre::Result<Self> {
        let comic_dir = comic
            .comic_download_dir
            .as_deref()
            .ok_or_eyre("漫画下载目录为空")?;
        let chapter_dir = chapter
            .chapter_download_dir
            .as_deref()
            .ok_or_eyre("章节下载目录为空")?;
        let temporary = chapter.get_temp_download_dir()?;
        for path in [comic_dir, chapter_dir, temporary.as_path()] {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(eyre::eyre!("下载目标不能是符号链接"));
                }
                Ok(_) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(err.into()),
            }
        }
        Ok(Self {
            root: cleanup::canonicalize_allow_missing(root)?,
            comic: cleanup::resolve_strictly_inside(comic_dir, root)?,
            chapter: cleanup::resolve_strictly_inside(chapter_dir, root)?,
            temporary: cleanup::resolve_strictly_inside(&temporary, root)?,
        })
    }

    pub fn validate(&self) -> eyre::Result<()> {
        if cleanup::canonicalize_allow_missing(&self.root)? != self.root {
            return Err(eyre::eyre!("任务创建后的下载根目录已被替换"));
        }
        for path in [&self.comic, &self.chapter, &self.temporary] {
            cleanup::ensure_strictly_inside(path, &self.root)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captured_root_cleans_old_files_after_config_changes() {
        let base = std::env::temp_dir().join(format!("jmcomic-root-test-{}", uuid::Uuid::new_v4()));
        let old_root = base.join("old");
        let mut configured_root = old_root.clone();
        let comic = Comic {
            comic_download_dir: Some(old_root.join("comic")),
            ..Comic::default()
        };
        let chapter = ChapterInfo {
            chapter_download_dir: Some(old_root.join("comic/chapter")),
            ..ChapterInfo::default()
        };
        let paths = DownloadPaths::new(&configured_root, &comic, &chapter).unwrap();
        std::fs::create_dir_all(&paths.temporary).unwrap();
        std::fs::write(paths.temporary.join("0001.webp"), "partial").unwrap();
        configured_root = base.join("new");
        std::fs::create_dir_all(configured_root.join("keep")).unwrap();

        paths.validate().unwrap();
        cleanup::remove_dir_inside(&paths.temporary, &paths.root)
            .await
            .unwrap();

        assert!(!paths.temporary.exists());
        assert!(configured_root.join("keep").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_leaf_links_and_replaced_roots() {
        let base = std::env::temp_dir().join(format!("jmcomic-path-test-{}", uuid::Uuid::new_v4()));
        let root = base.join("download");
        std::fs::create_dir_all(root.join("comic")).unwrap();
        std::fs::create_dir_all(root.join("other-chapter")).unwrap();
        let comic = Comic {
            comic_download_dir: Some(root.join("comic")),
            ..Comic::default()
        };
        let chapter = ChapterInfo {
            chapter_download_dir: Some(root.join("comic/chapter")),
            ..ChapterInfo::default()
        };
        std::os::unix::fs::symlink(root.join("other-chapter"), root.join("comic/chapter")).unwrap();
        assert!(DownloadPaths::new(&root, &comic, &chapter).is_err());
        std::fs::remove_file(root.join("comic/chapter")).unwrap();
        let paths = DownloadPaths::new(&root, &comic, &chapter).unwrap();
        std::fs::rename(&root, base.join("moved")).unwrap();
        std::fs::create_dir_all(base.join("outside")).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), &root).unwrap();
        assert!(paths.validate().is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}
