use crate::{
    cleanup, commands,
    downloader::{
        download_img_task::{calculate_block_num, save_img},
        download_task_state::DownloadTaskState,
        image_writes::ImageWrites,
    },
    errors::{CommandError, CommandResult},
    extensions::AppHandleExt,
    jm_client::IMAGE_DOMAIN,
    types::{ChapterInfo, Comic, DownloadFormat},
};
use eyre::{eyre, OptionExt, WrapErr};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::AppHandle;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageIssue {
    pub page: u32,
    pub reason: String,
    pub repairable: bool,
}
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChapterHealth {
    pub comic_id: i64,
    pub comic_name: String,
    pub chapter_id: i64,
    pub chapter_title: String,
    pub expected_pages: Option<u32>,
    pub checked_pages: u32,
    pub issues: Vec<PageIssue>,
    pub warning: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct PageManifest {
    total: u32,
    format: DownloadFormat,
}

pub fn write_manifest(directory: &Path, total: u32, format: DownloadFormat) -> eyre::Result<()> {
    let temporary = directory.join(format!(".page-manifest-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(&PageManifest { total, format })?;
    std::fs::write(&temporary, bytes)?;
    let result = std::fs::rename(&temporary, directory.join("页面清单.json"));
    if result.is_err() {
        if let Err(error) = std::fs::remove_file(&temporary) {
            tracing::warn!(%error, "清理页面清单临时文件失败");
        }
    }
    result.wrap_err("保存页面清单失败")
}

fn image_files(directory: &Path) -> eyre::Result<BTreeMap<u32, Vec<PathBuf>>> {
    let mut pages: BTreeMap<u32, Vec<PathBuf>> = BTreeMap::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if !matches!(
            extension.to_ascii_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "gif"
        ) {
            continue;
        }
        let Some(page) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|page| *page > 0)
        else {
            continue;
        };
        pages.entry(page).or_default().push(path);
    }
    for files in pages.values_mut() {
        files.sort();
    }
    Ok(pages)
}

fn image_problem(path: &Path) -> Option<String> {
    let check = || -> eyre::Result<()> {
        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(eyre!("不是普通图片文件"));
        }
        if metadata.len() == 0 {
            return Err(eyre!("文件为空"));
        }
        image::ImageReader::open(path)?
            .with_guessed_format()?
            .decode()
            .wrap_err("图片无法解码")?;
        Ok(())
    };
    check().err().map(|error| format!("{error:#}"))
}

fn inspect_pages(directory: &Path, expected: Option<u32>) -> eyre::Result<(u32, Vec<PageIssue>)> {
    let files = image_files(directory)?;
    let total = expected.unwrap_or_else(|| files.keys().copied().max().unwrap_or(0));
    if total > 20_000 {
        return Err(eyre!("章节页数超过检查上限 20000"));
    }
    let mut issues = Vec::new();
    for page in 1..=total {
        let Some(candidates) = files.get(&page) else {
            issues.push(PageIssue {
                page,
                reason: "缺少图片".into(),
                repairable: true,
            });
            continue;
        };
        if candidates.iter().any(|path| image_problem(path).is_none()) {
            continue;
        }
        let repairable = candidates.iter().all(|path| {
            std::fs::symlink_metadata(path)
                .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        });
        let reason = candidates
            .iter()
            .filter_map(|path| image_problem(path))
            .collect::<Vec<_>>()
            .join("；");
        issues.push(PageIssue {
            page,
            reason,
            repairable,
        });
    }
    Ok((total, issues))
}

fn local_chapter(
    app: &AppHandle,
    comic_id: i64,
    chapter_id: i64,
) -> eyre::Result<(PathBuf, PathBuf, Comic, ChapterInfo)> {
    let comic = commands::get_downloaded_comics(app.clone())
        .into_iter()
        .find(|comic| comic.id == comic_id)
        .ok_or_eyre("本地库存中找不到这部漫画")?;
    let chapter = comic
        .chapter_infos
        .iter()
        .find(|chapter| chapter.chapter_id == chapter_id)
        .cloned()
        .ok_or_eyre("找不到章节")?;
    let root = app.get_config().read().download_dir.clone();
    let directory = chapter
        .chapter_download_dir
        .as_ref()
        .ok_or_eyre("章节尚未下载")?;
    if std::fs::symlink_metadata(directory)?
        .file_type()
        .is_symlink()
    {
        return Err(eyre!("不能检查符号链接目录"));
    }
    let directory = cleanup::resolve_strictly_inside(directory, &root)?;
    Ok((
        cleanup::canonicalize_allow_missing(&root)?,
        directory,
        comic,
        chapter,
    ))
}

fn downloadable_names(names: Vec<String>) -> eyre::Result<Vec<String>> {
    let mut result = Vec::new();
    for name in names {
        if name.is_empty() || name.contains(['/', '\\', '?', '#']) {
            return Err(eyre!("章节图片文件名无效"));
        }
        let extension = Path::new(&name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if matches!(extension.to_ascii_lowercase().as_str(), "webp" | "gif") {
            result.push(name);
        }
    }
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn inspect_chapter(
    app: AppHandle,
    comic_id: i64,
    chapter_id: i64,
    verify_remote: bool,
) -> CommandResult<ChapterHealth> {
    inspect(&app, comic_id, chapter_id, verify_remote)
        .await
        .map_err(|error| CommandError::from("检查库存失败", error))
}
async fn inspect(
    app: &AppHandle,
    comic_id: i64,
    chapter_id: i64,
    verify_remote: bool,
) -> eyre::Result<ChapterHealth> {
    let lookup = app.clone();
    let (_root, directory, comic, chapter) =
        tokio::task::spawn_blocking(move || local_chapter(&lookup, comic_id, chapter_id)).await??;
    let mut warning = None;
    let mut expected = match tokio::fs::read(directory.join("页面清单.json")).await {
        Ok(bytes) => match serde_json::from_slice::<PageManifest>(&bytes) {
            Ok(manifest) => Some(manifest.total),
            Err(error) => {
                warning = Some(format!("页面清单无法读取：{error}"));
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if verify_remote {
        match app.get_jm_client().get_chapter(chapter_id).await {
            Ok(remote) => {
                expected = Some(u32::try_from(downloadable_names(remote.images)?.len())?);
            }
            Err(error) => warning = Some(format!("联网核对失败，仍检查本地文件：{error:#}")),
        }
    }
    if expected.is_none() {
        warning = Some(format!(
            "{}未取得总页数，无法确认末尾是否缺页",
            warning
                .map(|message| format!("{message}；"))
                .unwrap_or_default()
        ));
    }
    let (checked_pages, issues) =
        tokio::task::spawn_blocking(move || inspect_pages(&directory, expected)).await??;
    Ok(ChapterHealth {
        comic_id,
        comic_name: comic.name,
        chapter_id,
        chapter_title: chapter.chapter_title,
        expected_pages: expected,
        checked_pages,
        issues,
        warning,
    })
}

fn install_repaired_page(
    directory: &Path,
    page: u32,
    temporary: &Path,
    extension: &str,
) -> eyre::Result<bool> {
    if image_problem(temporary).is_some() {
        return Err(eyre!("新图片校验失败，原文件未改动"));
    }
    let candidates = image_files(directory)?.remove(&page).unwrap_or_default();
    if candidates.iter().any(|path| image_problem(path).is_none()) {
        std::fs::remove_file(temporary)?;
        return Ok(false);
    }
    for path in &candidates {
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(eyre!("目标不是普通文件，未改动"));
        }
    }
    let mut backups: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| -> eyre::Result<()> {
        for path in candidates {
            let filename = path
                .file_name()
                .ok_or_eyre("图片文件名无效")?
                .to_string_lossy();
            let backup = directory.join(format!(".修复前-{}-{filename}", uuid::Uuid::new_v4()));
            std::fs::rename(&path, &backup)?;
            backups.push((path, backup));
        }
        std::fs::rename(temporary, directory.join(format!("{page:04}.{extension}")))?;
        Ok(())
    })();
    if let Err(error) = result {
        for (path, backup) in backups.into_iter().rev() {
            if let Err(rollback) = std::fs::rename(&backup, &path) {
                tracing::error!(%rollback, backup = %backup.display(), "恢复修复前文件失败");
            }
        }
        return Err(error);
    }
    Ok(true)
}

fn repair_format(
    directory: &Path,
    page: u32,
    fallback: DownloadFormat,
) -> eyre::Result<Option<DownloadFormat>> {
    let files = image_files(directory)?;
    let candidates = files.get(&page);
    if candidates.is_some_and(|paths| paths.iter().any(|path| image_problem(path).is_none())) {
        return Ok(None);
    }
    let existing = candidates
        .and_then(|paths| paths.first())
        .or_else(|| files.values().flatten().next());
    let from_extension = existing
        .and_then(|path| path.extension())
        .and_then(|value| value.to_str())
        .and_then(|extension| match extension.to_ascii_lowercase().as_str() {
            "png" => Some(DownloadFormat::Png),
            "webp" => Some(DownloadFormat::Webp),
            "jpg" | "jpeg" => Some(DownloadFormat::Jpeg),
            _ => None,
        });
    if let Some(format) = from_extension {
        return Ok(Some(format));
    }
    let manifest = match std::fs::read(directory.join("页面清单.json")) {
        Ok(bytes) => match serde_json::from_slice::<PageManifest>(&bytes) {
            Ok(saved) => Some(saved),
            Err(error) => {
                tracing::warn!(%error, "页面清单无效，使用当前图片格式");
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    Ok(Some(manifest.map_or(fallback, |saved| saved.format)))
}

#[tauri::command]
#[specta::specta]
pub async fn repair_chapter_page(
    app: AppHandle,
    comic_id: i64,
    chapter_id: i64,
    page: u32,
) -> CommandResult<bool> {
    repair(&app, comic_id, chapter_id, page)
        .await
        .map_err(|error| CommandError::from("修复页面失败", error))
}
async fn repair(app: &AppHandle, comic_id: i64, chapter_id: i64, page: u32) -> eyre::Result<bool> {
    if page == 0 {
        return Err(eyre!("页码必须大于零"));
    }
    let manager = app.get_download_manager();
    let _guard = Arc::clone(&manager.cleanup_gate)
        .try_lock_owned()
        .wrap_err("另一个文件操作正在进行，请稍后重试")?;
    if manager
        .download_tasks
        .read()
        .get(&chapter_id)
        .is_some_and(|task| {
            !matches!(
                *task.state_sender.borrow(),
                DownloadTaskState::Completed | DownloadTaskState::Cancelled
            )
        })
    {
        return Err(eyre!("该章节仍有下载任务，请先取消任务后再修复"));
    }
    let lookup = app.clone();
    let (root, directory, _comic, _chapter) =
        tokio::task::spawn_blocking(move || local_chapter(&lookup, comic_id, chapter_id)).await??;
    let client = app.get_jm_client().inner().clone();
    let (remote, scramble) = tokio::try_join!(
        client.get_chapter(chapter_id),
        client.get_scramble_id(chapter_id)
    )?;
    let names = downloadable_names(remote.images)?;
    let filename = names
        .get(usize::try_from(page - 1)?)
        .ok_or_eyre("页码超出当前章节范围")?;
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_eyre("图片文件名无效")?;
    let blocks = if filename.to_ascii_lowercase().ends_with(".gif") {
        0
    } else {
        calculate_block_num(scramble, chapter_id, stem)
    };
    let format_directory = directory.clone();
    let fallback = app.get_config().read().download_format;
    let Some(format) =
        tokio::task::spawn_blocking(move || repair_format(&format_directory, page, fallback))
            .await??
    else {
        return Ok(false);
    };
    let url = format!("https://{IMAGE_DOMAIN}/media/photos/{chapter_id}/{filename}");
    let (bytes, source_format) = client.get_img_data_and_format(&url).await?;
    if cleanup::resolve_strictly_inside(&directory, &root)? != directory {
        return Err(eyre!("章节目录已变化，请重新检查"));
    }
    let extension = if source_format == image::ImageFormat::Gif {
        "gif"
    } else {
        format.extension()
    };
    let temporary = directory.join(format!(".repair-{}.{}", uuid::Uuid::new_v4(), extension));
    let result = async {
        save_img(
            &ImageWrites::new(),
            &temporary,
            format,
            blocks,
            bytes,
            source_format,
        )
        .await?;
        let install_dir = directory.clone();
        let install_temp = temporary.clone();
        let install_root = root.clone();
        let total = u32::try_from(names.len())?;
        let repaired = tokio::task::spawn_blocking(move || {
            if cleanup::resolve_strictly_inside(&install_dir, &install_root)? != install_dir {
                return Err(eyre!("章节目录已变化"));
            }
            let repaired = install_repaired_page(&install_dir, page, &install_temp, extension)?;
            write_manifest(&install_dir, total, format)?;
            Ok::<bool, eyre::Report>(repaired)
        })
        .await??;
        Ok(repaired)
    }
    .await;
    if let Err(error) = tokio::fs::remove_file(&temporary).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, "清理修复临时文件失败");
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!("jmcomic-integrity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn png(path: &Path) {
        image::RgbImage::new(16, 24)
            .save_with_format(path, image::ImageFormat::Png)
            .unwrap();
    }
    #[test]
    fn detects_missing_empty_and_corrupt_pages() {
        let root = fixture();
        png(&root.join("0001.png"));
        std::fs::write(root.join("0002.png"), []).unwrap();
        std::fs::write(root.join("0003.png"), b"broken image").unwrap();
        let (_, issues) = inspect_pages(&root, Some(4)).unwrap();
        assert_eq!(
            issues.iter().map(|issue| issue.page).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn repairs_only_the_bad_page_and_keeps_good_bytes_and_backup() {
        let root = fixture();
        png(&root.join("0001.png"));
        let good = std::fs::read(root.join("0001.png")).unwrap();
        std::fs::write(root.join("0002.png"), b"bad").unwrap();
        let temporary = root.join(".replacement.png");
        png(&temporary);
        assert!(install_repaired_page(&root, 2, &temporary, "png").unwrap());
        assert_eq!(std::fs::read(root.join("0001.png")).unwrap(), good);
        assert!(inspect_pages(&root, Some(2)).unwrap().1.is_empty());
        assert!(std::fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".修复前-")));
        png(&temporary);
        assert!(!install_repaired_page(&root, 1, &temporary, "png").unwrap());
        assert_eq!(std::fs::read(root.join("0001.png")).unwrap(), good);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_replacement_preserves_original() {
        let root = fixture();
        std::fs::write(root.join("0001.png"), b"original").unwrap();
        let temporary = root.join(".replacement.png");
        std::fs::write(&temporary, b"invalid").unwrap();
        assert!(install_repaired_page(&root, 1, &temporary, "png").is_err());
        assert_eq!(std::fs::read(root.join("0001.png")).unwrap(), b"original");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_page_uses_existing_chapter_format() {
        let root = fixture();
        png(&root.join("0001.png"));
        assert_eq!(
            repair_format(&root, 2, DownloadFormat::Jpeg).unwrap(),
            Some(DownloadFormat::Png)
        );
        assert_eq!(repair_format(&root, 1, DownloadFormat::Jpeg).unwrap(), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linked_page_is_reported_without_touching_its_target() {
        let root = fixture();
        let outside = fixture();
        let target = outside.join("original.png");
        png(&target);
        let before = std::fs::read(&target).unwrap();
        std::os::unix::fs::symlink(&target, root.join("0001.png")).unwrap();
        let issues = inspect_pages(&root, Some(1)).unwrap().1;
        assert_eq!(issues.len(), 1);
        assert!(!issues[0].repairable);
        let temporary = root.join(".replacement.png");
        png(&temporary);
        assert!(install_repaired_page(&root, 1, &temporary, "png").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
