use parking_lot::RwLock;
use tauri::{Manager, State};

use crate::{
    config::Config, downloader::download_manager::DownloadManager, export::ComicExportLock,
    jm_client::JmClient,
};

pub trait EyreReportToMessage {
    fn to_message(&self) -> String;
}

impl EyreReportToMessage for eyre::Report {
    fn to_message(&self) -> String {
        format!("{self:?}")
    }
}

pub trait PathIsImg {
    /// 判断路径是否为章节图片(jpg/png/webp/gif)，隐藏文件(如修复页面留下的备份)除外
    fn is_img(&self) -> bool;

    /// 判断路径是否为普通章节图片(jpg/png/webp)，隐藏文件除外
    fn is_common_img(&self) -> bool;
}

impl PathIsImg for std::path::Path {
    fn is_img(&self) -> bool {
        !is_hidden(self)
            && self
                .extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_lowercase)
                .is_some_and(|ext| matches!(ext.as_str(), "jpg" | "png" | "webp" | "gif"))
    }

    fn is_common_img(&self) -> bool {
        !is_hidden(self)
            && self
                .extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_lowercase)
                .is_some_and(|ext| matches!(ext.as_str(), "jpg" | "png" | "webp"))
    }
}

fn is_hidden(path: &std::path::Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.as_encoded_bytes().starts_with(b"."))
}

pub trait WalkDirEntryExt {
    fn is_comic_metadata(&self) -> bool;
    fn is_chapter_metadata(&self) -> bool;
}
impl WalkDirEntryExt for walkdir::DirEntry {
    fn is_comic_metadata(&self) -> bool {
        if !self.file_type().is_file() {
            return false;
        }
        if self.file_name() != "元数据.json" {
            return false;
        }

        true
    }

    fn is_chapter_metadata(&self) -> bool {
        if !self.file_type().is_file() {
            return false;
        }
        if self.file_name() != "章节元数据.json" {
            return false;
        }

        true
    }
}

pub trait AppHandleExt {
    fn get_config(&self) -> State<'_, RwLock<Config>>;
    fn get_jm_client(&self) -> State<'_, JmClient>;
    fn get_download_manager(&self) -> State<'_, DownloadManager>;
    fn get_export_lock(&self) -> State<'_, ComicExportLock>;
}

impl AppHandleExt for tauri::AppHandle {
    fn get_config(&self) -> State<'_, RwLock<Config>> {
        self.state::<RwLock<Config>>()
    }
    fn get_jm_client(&self) -> State<'_, JmClient> {
        self.state::<JmClient>()
    }
    fn get_download_manager(&self) -> State<'_, DownloadManager> {
        self.state::<DownloadManager>()
    }
    fn get_export_lock(&self) -> State<'_, ComicExportLock> {
        self.state::<ComicExportLock>()
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::PathIsImg;

    #[test]
    fn hidden_files_are_not_chapter_images() {
        // 修复备份、修复临时文件和 macOS 的 ._ 文件虽然带图片扩展名，但不是章节页面
        for name in [".修复前-1-0002.png", ".repair-1.jpg", "._0001.webp"] {
            assert!(!Path::new(name).is_img(), "{name}");
            assert!(!Path::new(name).is_common_img(), "{name}");
        }
        assert!(Path::new("/comic/1/0001.WEBP").is_common_img());
        assert!(Path::new("/comic/1/0002.gif").is_img());
        // 只看文件名本身，下载中的临时目录`.下载中-*`里的页面仍是图片
        assert!(Path::new("/comic/.下载中-1/0001.webp").is_img());
    }
}
