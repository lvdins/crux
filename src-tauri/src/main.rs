#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;

use std::net::TcpStream;
use tauri::{Emitter, Manager};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

/// Project root, resolved at compile time. QualityLab is a local tool whose
/// config already carries absolute repo paths, so a compile-time root is fine.
const PROJECT_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

fn server_running() -> bool {
    TcpStream::connect_timeout(&"127.0.0.1:8787".parse().unwrap(), Duration::from_millis(300)).is_ok()
}

/// Packaged app: run the bundled Node + server from Resources/ql-runtime.
/// Development: fall back to `npm run start -w server` in the repo.
fn spawn_server(app: &tauri::App) -> Option<Child> {
    if server_running() {
        // Dev convenience: a server started by `npm run dev` is already up.
        return None;
    }
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("ql-runtime"))
        .filter(|root| root.join("node").exists() && root.join("server/dist/index.mjs").exists());

    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let mut cmd = match bundled {
        Some(root) => {
            let mut c = Command::new(root.join("node"));
            c.arg(root.join("server/dist/index.mjs")).env("QUALITYLAB_ROOT", &root).current_dir(&home);
            c
        }
        None => {
            let mut c = Command::new("npm");
            c.args(["run", "start", "-w", "server"]).current_dir(PROJECT_ROOT);
            c
        }
    };
    // Keep a log for "it doesn't start" reports: ~/.qualitylab/server.log
    let log_dir = std::path::Path::new(&home).join(".qualitylab");
    let _ = std::fs::create_dir_all(&log_dir);
    if let Ok(log) = std::fs::OpenOptions::new().create(true).append(true).open(log_dir.join("server.log")) {
        if let Ok(err) = log.try_clone() {
            cmd.stdout(log).stderr(err);
        }
    }
    match cmd.spawn() {
        Ok(child) => {
            // Give the server a moment to bind before the UI starts polling.
            for _ in 0..75 {
                if server_running() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Some(child)
        }
        Err(err) => {
            eprintln!("failed to start QualityLab server: {err}");
            None
        }
    }
}

/// Default macOS menu plus View → Toggle Sidebar (⌘S) / Right Panel (⌘B). A menu accelerator
/// fires even when a terminal or a native browser pane has keyboard focus.
fn install_menu(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, SubmenuBuilder};
    let toggle = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let toggle_right = MenuItemBuilder::with_id("toggle-right", "Toggle Right Panel")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let menu = Menu::default(app.handle())?;
    let mut placed = false;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item {
            if sub.text()? == "View" {
                sub.prepend(&toggle_right)?;
                sub.prepend(&toggle)?;
                placed = true;
            }
        }
    }
    if !placed {
        menu.append(&SubmenuBuilder::new(app, "View").item(&toggle).item(&toggle_right).build()?)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

fn main() {
    let server: std::sync::Arc<Mutex<Option<Child>>> = Default::default();
    let server_for_setup = server.clone();

    tauri::Builder::default()
        .setup(move |app| {
            *server_for_setup.lock().unwrap() = spawn_server(app);
            install_menu(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "toggle-sidebar" => {
                    let _ = app.emit_to("main", "menu:toggle-sidebar", ());
                }
                "toggle-right" => {
                    let _ = app.emit_to("main", "menu:toggle-right", ());
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            browser::browser_show,
            browser::browser_hide,
            browser::browser_navigate,
            browser::browser_action,
            browser::browser_close,
            browser::browser_ensure,
            browser::browser_js,
            browser::browser_screenshot,
        ])
        .build(tauri::generate_context!())
        .expect("error building QualityLab")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = server.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
