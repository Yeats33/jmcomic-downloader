use events::{
    DownloadAllFavoritesEvent, DownloadEvent, ExportCbzEvent, ExportPdfEvent, LogEvent,
    UpdateDownloadedComicsEvent,
};
use eyre::WrapErr;
use parking_lot::RwLock;
use std::path::Path;
use tauri::{Manager, Wry};

// TODO: 用prelude来消除警告
use crate::commands::*;
use crate::config::Config;
use crate::downloader::download_manager::DownloadManager;
use crate::errors::install_custom_eyre_handler;
use crate::export::ComicExportLock;
use crate::jm_client::JmClient;
use crate::online_reader::{
    close_online_reader, open_online_chapter, start_online_reader, stream_online_page, OnlineReader,
};

mod cleanup;
mod commands;
mod config;
mod downloader;
mod errors;
mod events;
mod export;
mod extensions;
mod jm_client;
mod logger;
mod online_reader;
mod responses;
mod types;
mod utils;

fn generate_context() -> tauri::Context<Wry> {
    tauri::generate_context!()
}

/// 构建`tauri-specta`的Builder, 用于收集命令/事件并生成TypeScript绑定
fn specta_builder() -> tauri_specta::Builder<Wry> {
    tauri_specta::Builder::<Wry>::new()
        .commands(tauri_specta::collect_commands![
            greet,
            get_config,
            save_config,
            login,
            search,
            get_comic,
            get_favorite_folder,
            get_weekly_info,
            get_weekly,
            get_user_profile,
            create_download_task,
            create_download_tasks,
            get_chapter_downloaded_imgs,
            open_online_chapter,
            start_online_reader,
            stream_online_page,
            close_online_reader,
            pause_download_task,
            resume_download_task,
            cancel_download_task,
            delete_download_task,
            download_comic,
            download_all_favorites,
            update_downloaded_comics,
            delete_downloaded_comic,
            show_path_in_file_manager,
            sync_favorite_folder,
            get_downloaded_comics,
            export_cbz,
            export_pdf,
            export_cbz_chapters,
            export_pdf_chapters,
            export_single_pdf,
            get_logs_dir_size,
            get_synced_comic,
            get_synced_comic_in_favorite,
            get_synced_comic_in_search,
            get_synced_comic_in_weekly,
            open_log_file,
        ])
        .events(tauri_specta::collect_events![
            DownloadEvent,
            DownloadAllFavoritesEvent,
            UpdateDownloadedComicsEvent,
            ExportCbzEvent,
            ExportPdfEvent,
            LogEvent,
        ])
}

// TODO: 添加Panic Doc
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_custom_eyre_handler().unwrap();

    let builder = specta_builder();

    #[cfg(debug_assertions)]
    export_bindings("../src/bindings.ts").expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

            let app_data_dir = app
                .path()
                .app_data_dir()
                .wrap_err("failed to get app data dir")?;

            std::fs::create_dir_all(&app_data_dir).wrap_err(format!(
                "failed to create app data dir: {}",
                app_data_dir.display()
            ))?;

            let config = RwLock::new(Config::new(app.handle())?);
            app.manage(config);

            let jm_client = JmClient::new(app.handle().clone());
            app.manage(jm_client);
            app.manage(OnlineReader::default());

            let download_manager = DownloadManager::new(app.handle());
            app.manage(download_manager);

            let export_lock = ComicExportLock::new();
            app.manage(export_lock);

            logger::init(app.handle())?;

            Ok(())
        })
        .run(generate_context())
        .expect("error while running tauri application");
}

/// 把TypeScript绑定写入`path`
///
/// 不使用外部格式化工具(`prettier`): 它的存在与否取决于`PATH`，
/// 会导致同样的代码在不同环境下生成出不同的文件(产生大量无意义的diff)
fn export_bindings(path: impl AsRef<Path>) -> eyre::Result<()> {
    let path = path.as_ref();

    let content = specta_builder()
        .export_str(
            specta_typescript::Typescript::default()
                .bigint(specta_typescript::BigIntExportBehavior::Number)
                .header("// @ts-nocheck"), // 跳过检查
        )
        .map_err(eyre::Report::from)
        .wrap_err("生成TypeScript绑定失败")?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).wrap_err(format!("创建目录`{}`失败", parent.display()))?;
    }
    std::fs::write(path, content).wrap_err(format!("写入文件`{}`失败", path.display()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    /// 重新生成`src/bindings.ts`(运行`cargo test`即可刷新TypeScript绑定)
    #[test]
    fn export_bindings() {
        super::export_bindings("../src/bindings.ts").expect("Failed to export typescript bindings");
    }
}
