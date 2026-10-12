#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;

use std::net::TcpStream;
use tauri::{Emitter, Manager};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// Settings → Background, pushed by the client with `set_background`.
static KEEP_RUNNING: AtomicBool = AtomicBool::new(true);
static QUICK_ASK: AtomicBool = AtomicBool::new(false);

/// Project root, resolved at compile time. Crux is a local tool whose
/// config already carries absolute repo paths, so a compile-time root is fine.
const PROJECT_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

/// 8787 for the installed app; `npm run app:dev` sets CRUX_PORT=8788.
fn server_port() -> u16 {
    std::env::var("CRUX_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8787)
}

fn server_running() -> bool {
    let addr = format!("127.0.0.1:{}", server_port());
    TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(300)).is_ok()
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
            c.arg(root.join("server/dist/index.mjs")).env("CRUX_ROOT", &root).current_dir(&home);
            c
        }
        None => {
            let mut c = Command::new("npm");
            c.args(["run", "start", "-w", "server"]).current_dir(PROJECT_ROOT);
            c
        }
    };
    // Keep a log for "it doesn't start" reports: ~/.crux/server.log
    let log_dir = std::env::var("CRUX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::Path::new(&home).join(".crux"));
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
            eprintln!("failed to start Crux server: {err}");
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
    // ⌘⇧C: mark an issue in the browser pane for the agent to explore.
    let report = MenuItemBuilder::with_id("report-issue", "Mark Issue in Browser")
        .accelerator("CmdOrCtrl+Shift+C")
        .build(app)?;
    // ⌘K: search open and past chats.
    let search = MenuItemBuilder::with_id("search-chats", "Search Chats")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let menu = Menu::default(app.handle())?;
    let mut placed = false;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item {
            if sub.text()? == "View" {
                sub.prepend(&search)?;
                sub.prepend(&report)?;
                sub.prepend(&toggle_right)?;
                sub.prepend(&toggle)?;
                placed = true;
            }
        }
    }
    if !placed {
        menu.append(&SubmenuBuilder::new(app, "View").item(&toggle).item(&toggle_right).item(&report).item(&search).build()?)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// ⌥Space from any app: a small always-on-top box that sends a prompt to an agent.
/// Made on first use; the same client renders QuickAsk when `__CRUX_QUICK__` is set.
fn toggle_quick(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.center();
            let _ = w.show();
            let _ = w.set_focus();
            let _ = app.emit_to("quick", "quick:shown", ());
        }
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(app, "quick", tauri::WebviewUrl::App("index.html".into()))
        .title("Quick ask")
        .inner_size(600.0, 168.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .center()
        .initialization_script("window.__CRUX_QUICK__ = true;")
        .build();
    if let Ok(w) = built {
        let _ = w.set_focus();
    }
}

/// Settings → Background: keep running when the window closes, ⌥Space quick ask.
#[tauri::command]
fn set_background(app: tauri::AppHandle, keep_running: bool, quick_ask: bool) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    KEEP_RUNNING.store(keep_running, Ordering::Relaxed);
    let was = QUICK_ASK.swap(quick_ask, Ordering::Relaxed);
    let shortcuts = app.global_shortcut();
    let registered = shortcuts.is_registered(quick_shortcut());
    if quick_ask && !registered {
        if let Err(err) = shortcuts.register(quick_shortcut()) {
            eprintln!("⌥Space is taken: {err}");
        }
    } else if !quick_ask && (registered || was) {
        let _ = shortcuts.unregister(quick_shortcut());
    }
}

/// Menu bar text next to the icon: agents working / waiting for you (blank when none).
#[tauri::command]
fn set_tray_title(app: tauri::AppHandle, title: String) {
    if let Some(tray) = app.tray_by_id("crux") {
        let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
    }
}

/// Start at login records this binary's path: only safe from /Applications
/// (a DMG or quarantined Downloads copy runs from a temporary folder).
#[tauri::command]
fn in_applications() -> bool {
    std::env::current_exe()
        .map(|p| p.starts_with("/Applications") || p.to_string_lossy().contains("/Users/") && p.to_string_lossy().contains("/Applications/"))
        .unwrap_or(false)
}

#[tauri::command]
fn quick_hide(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn main_show(app: tauri::AppHandle) {
    show_main(&app);
}

fn quick_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// Menu bar icon: open Crux, quick ask, quit (closing the window only hides it).
fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItemBuilder::with_id("tray-open", "Open Crux").build(app)?;
    let quick = MenuItemBuilder::with_id("tray-quick", "Quick Ask…").accelerator("Alt+Space").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit Crux").accelerator("CmdOrCtrl+Q").build(app)?;
    let menu = MenuBuilder::new(app).item(&open).item(&quick).separator().item(&quit).build()?;
    let mut tray = TrayIconBuilder::with_id("crux")
        .tooltip("Crux")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main(app),
            "tray-quick" => toggle_quick(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    let server: std::sync::Arc<Mutex<Option<Child>>> = Default::default();
    let server_for_setup = server.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_quick(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            browser::keep_logins(app.handle().clone());
            *server_for_setup.lock().unwrap() = spawn_server(app);
            install_menu(app)?;
            install_tray(app)?;
            // Started at login: stay in the menu bar until opened.
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the main window keeps Crux (agents, checks) running in the menu bar.
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" && KEEP_RUNNING.load(Ordering::Relaxed) => {
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Focused(false) if window.label() == "quick" => {
                let _ = window.hide();
            }
            _ => {}
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "toggle-sidebar" => {
                    let _ = app.emit_to("main", "menu:toggle-sidebar", ());
                }
                "toggle-right" => {
                    let _ = app.emit_to("main", "menu:toggle-right", ());
                }
                "report-issue" => {
                    let _ = app.emit_to("main", "menu:report-issue", ());
                }
                "search-chats" => {
                    let _ = app.emit_to("main", "menu:search-chats", ());
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
            browser::browser_devtools,
            set_background,
            set_tray_title,
            quick_hide,
            main_show,
            in_applications,
        ])
        .build(tauri::generate_context!())
        .expect("error building Crux")
        .run(move |app, event| {
            // Dock icon clicked while the window is hidden.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = server.lock().unwrap().take() {
                    // Ask first, so the server saves every chat's screen for
                    // reopening; force it if it hasn't stopped after 2 s.
                    let _ = Command::new("kill").args(["-TERM", &child.id().to_string()]).status();
                    for _ in 0..20 {
                        if matches!(child.try_wait(), Ok(Some(_))) {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    let _ = child.kill();
                }
            }
        });
}
