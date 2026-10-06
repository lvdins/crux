#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;

use std::net::TcpStream;
use tauri::Emitter;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

/// Project root, resolved at compile time. QualityLab is a local tool whose
/// config already carries absolute repo paths, so a compile-time root is fine.
const PROJECT_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

fn server_running() -> bool {
    TcpStream::connect_timeout(&"127.0.0.1:8787".parse().unwrap(), Duration::from_millis(300)).is_ok()
}

fn spawn_server() -> Option<Child> {
    if server_running() {
        // Dev convenience: a server started by `npm run dev` is already up.
        return None;
    }
    let child = Command::new("npm")
        .args(["run", "start", "-w", "server"])
        .current_dir(PROJECT_ROOT)
        .spawn();
    match child {
        Ok(c) => {
            // Give the server a moment to bind before the UI starts polling.
            for _ in 0..50 {
                if server_running() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Some(c)
        }
        Err(err) => {
            eprintln!("failed to start QualityLab server: {err}");
            None
        }
    }
}

/// Default macOS menu plus View → Toggle Sidebar (⌘S). A menu accelerator
/// fires even when a terminal or a native browser pane has keyboard focus.
fn install_menu(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, SubmenuBuilder};
    let toggle = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let menu = Menu::default(app.handle())?;
    let mut placed = false;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item {
            if sub.text()? == "View" {
                sub.prepend(&toggle)?;
                placed = true;
            }
        }
    }
    if !placed {
        menu.append(&SubmenuBuilder::new(app, "View").item(&toggle).build()?)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

fn main() {
    let server: Mutex<Option<Child>> = Mutex::new(spawn_server());

    tauri::Builder::default()
        .setup(|app| {
            install_menu(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "toggle-sidebar" {
                let _ = app.emit_to("main", "menu:toggle-sidebar", ());
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
