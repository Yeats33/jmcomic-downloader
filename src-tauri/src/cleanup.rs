//! 删除下载产物(只允许删除下载目录之内的路径)
use std::path::{Path, PathBuf};

use eyre::{eyre, WrapErr};
use walkdir::WalkDir;

use crate::extensions::WalkDirEntryExt;

/// 确保`path`严格位于`download_dir`之内(防止越权删除下载目录之外的路径)
pub fn ensure_strictly_inside(path: &Path, download_dir: &Path) -> eyre::Result<()> {
    resolve_strictly_inside(path, download_dir).map(|_| ())
}

/// 解析现有祖先的符号链接，允许尚未创建的下载根目录和章节目录。
pub fn canonicalize_allow_missing(path: &Path) -> eyre::Result<PathBuf> {
    let mut ancestor = std::path::absolute(path)?;
    let mut missing = Vec::new();
    loop {
        match std::fs::canonicalize(&ancestor) {
            Ok(mut resolved) => {
                for name in missing.into_iter().rev() {
                    resolved.push(name);
                }
                return Ok(resolved);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                // 悬空链接不能被当成普通的、尚未创建的目录。
                match std::fs::symlink_metadata(&ancestor) {
                    Err(missing_err) if missing_err.kind() == std::io::ErrorKind::NotFound => {}
                    _ => return Err(err.into()),
                }
                let name = ancestor
                    .file_name()
                    .ok_or_else(|| eyre!("路径没有有效祖先"))?;
                missing.push(name.to_os_string());
                ancestor.pop();
            }
            Err(err) => return Err(err.into()),
        }
    }
}

pub fn resolve_strictly_inside(path: &Path, download_dir: &Path) -> eyre::Result<PathBuf> {
    if path == download_dir {
        return Err(eyre!("路径`{}`不能是下载目录本身", path.display()));
    }

    let relative = path.strip_prefix(download_dir).wrap_err(format!(
        "路径`{}`不在下载目录`{}`之内",
        path.display(),
        download_dir.display()
    ))?;

    // strip_prefix 只去除字面前缀，`..`组件仍可能逃出下载目录，所以还要拒绝含`..`的相对路径
    if relative
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(eyre!(
            "路径`{}`不在下载目录`{}`之内",
            path.display(),
            download_dir.display()
        ));
    }

    let root = canonicalize_allow_missing(download_dir)?;
    let resolved = canonicalize_allow_missing(path)?;
    if resolved == root || !resolved.starts_with(&root) {
        return Err(eyre!("路径`{}`解析后不在下载目录之内", path.display()));
    }
    Ok(resolved)
}

/// 删除`path`(必须是`download_dir`内部的路径)，目录不存在时静默返回
pub async fn remove_dir_inside(path: &Path, download_dir: &Path) -> eyre::Result<()> {
    let path = path.to_path_buf();
    let download_dir = download_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let resolved = resolve_strictly_inside(&path, &download_dir)?;
        let result = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => std::fs::remove_file(&path),
            Ok(_) => std::fs::remove_dir_all(&resolved),
            Err(err) => Err(err),
        };
        match result {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err).wrap_err(format!("删除目录`{}`失败", path.display())),
        }
    })
    .await
    .map_err(|err| eyre!("等待目录删除任务完成失败: {err}"))??;

    Ok(())
}

/// 删除`comic_download_dir`（必须是`download_dir`内部的路径），但仅当其中没有任何已完成章节时删除
pub async fn remove_comic_dir_if_no_chapters(
    comic_download_dir: &Path,
    download_dir: &Path,
) -> eyre::Result<()> {
    let comic_download_dir = comic_download_dir.to_path_buf();
    let download_dir = download_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let resolved = resolve_strictly_inside(&comic_download_dir, &download_dir)?;
        if !resolved.try_exists()? {
            return Ok(());
        }
        for entry in WalkDir::new(&resolved) {
            if entry?.is_chapter_metadata() {
                return Ok(());
            }
        }
        let metadata = std::fs::symlink_metadata(&comic_download_dir)?;
        let result = if metadata.file_type().is_symlink() {
            std::fs::remove_file(&comic_download_dir)
        } else {
            std::fs::remove_dir_all(&resolved)
        };
        result.wrap_err(format!(
            "删除漫画目录`{}`失败",
            comic_download_dir.display()
        ))
    })
    .await
    .map_err(|err| eyre!("等待目录删除任务完成失败: {err}"))??;

    Ok(())
}

#[cfg(test)]
mod tests;
