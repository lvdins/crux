#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;

use std::net::TcpStream;
use tauri::{Emitter, Manager};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    let updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
    let menu = Menu::default(app.handle())?;
    // App menu (first submenu, "Crux"): Check for Updates… under About.
    if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
        first.insert(&updates, 1)?;
    }
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

/// Take down Crux's delivered notifications with these titles (a chat's
/// "Finished" banner once you're looking at that chat). The notification
/// plugin can't remove them on macOS, so ask Notification Center directly.
#[tauri::command]
fn clear_notifications(app: tauri::AppHandle, titles: Vec<String>) {
    // NSUserNotification is deprecated, but it's what the notification plugin delivers with.
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(move || {
        #[allow(deprecated)]
        use objc2_foundation::NSUserNotificationCenter;
        #[allow(deprecated)]
        let center = NSUserNotificationCenter::defaultUserNotificationCenter();
        #[allow(deprecated)]
        for n in center.deliveredNotifications().iter() {
            if n.title().is_some_and(|t| titles.iter().any(|want| *want == t.to_string())) {
                center.removeDeliveredNotification(&n);
            }
        }
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (app, titles);
}

// ---------- macOS permissions (onboarding's Permissions step) ----------

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Screen Recording granted (Screenshot to agent needs it).
#[tauri::command]
fn screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    return unsafe { CGPreflightScreenCaptureAccess() };
    #[cfg(not(target_os = "macos"))]
    true
}

/// Ask for Screen Recording: the system prompt the first time; after that
/// macOS only lets you switch it on in System Settings, so open that pane.
#[tauri::command]
fn request_screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return true;
        }
        let granted = unsafe { CGRequestScreenCaptureAccess() };
        if !granted {
            open_privacy("ScreenCapture".into());
        }
        granted
    }
    #[cfg(not(target_os = "macos"))]
    true
}

/// Touch Documents, Desktop and Downloads so macOS asks for each now (repos
/// and agents' files live there) instead of mid-task. Which ones Crux can read.
#[tauri::command]
async fn request_folder_access() -> Vec<(String, bool)> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        ["Documents", "Desktop", "Downloads"]
            .iter()
            .map(|name| (name.to_string(), std::fs::read_dir(format!("{home}/{name}")).is_ok()))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Open a Privacy & Security pane in System Settings.
#[tauri::command]
fn open_privacy(pane: String) {
    let url = match pane.as_str() {
        "ScreenCapture" | "FilesAndFolders" => format!("x-apple.systempreferences:com.apple.preference.security?Privacy_{pane}"),
        "Notifications" => "x-apple.systempreferences:com.apple.Notifications-Settings.extension".into(),
        _ => return,
    };
    let _ = Command::new("open").arg(url).spawn();
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

/// Agent chats for the menu bar panel, as the main window last sent them (JSON).
static TRAY_CHATS: Mutex<String> = Mutex::new(String::new());
/// When the panel last hid on losing focus: a click on the menu bar icon
/// blurs it first, and that same click must not open it again.
static TRAY_HIDDEN_AT: AtomicU64 = AtomicU64::new(0);
const TRAY_WIDTH: f64 = 380.0;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The main window pushes its open agent chats here; the panel gets them live.
#[tauri::command]
fn set_tray_chats(app: tauri::AppHandle, chats: serde_json::Value) {
    *TRAY_CHATS.lock().unwrap() = chats.to_string();
    let _ = app.emit_to("tray", "tray:chats", chats);
}

#[tauri::command]
fn tray_chats() -> serde_json::Value {
    serde_json::from_str(&TRAY_CHATS.lock().unwrap()).unwrap_or_else(|_| serde_json::json!([]))
}

/// The panel sized itself to its content.
#[tauri::command]
fn tray_fit(app: tauri::AppHandle, height: f64) {
    if let Some(w) = app.get_webview_window("tray") {
        let _ = w.set_size(tauri::LogicalSize::new(TRAY_WIDTH, height.clamp(60.0, 620.0)));
    }
}

/// Panel buttons: a chat, or open / quick ask / updates / quit.
#[tauri::command]
fn tray_action(app: tauri::AppHandle, action: String, chat: Option<String>) {
    if let Some(w) = app.get_webview_window("tray") {
        let _ = w.hide();
    }
    match action.as_str() {
        "chat" => {
            show_main(&app);
            if let Some(chat) = chat {
                let _ = app.emit_to("main", "tray:open-chat", chat);
            }
        }
        "open" => show_main(&app),
        "quick" => toggle_quick(&app),
        "capture" => capture_screen(&app),
        "updates" => {
            show_main(&app);
            let _ = app.emit_to("main", "menu:check-updates", ());
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Screenshot to agent: macOS region capture (drag a box anywhere, Esc
/// cancels), then Crux comes forward and asks which agent gets it.
fn capture_screen(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        use base64::Engine;
        let file = std::env::temp_dir().join(format!("crux-shot-{}.png", now_ms()));
        let _ = Command::new("/usr/sbin/screencapture").args(["-i", "-x"]).arg(&file).status();
        // No file: cancelled.
        let Ok(png) = std::fs::read(&file) else { return };
        let _ = std::fs::remove_file(&file);
        show_main(&app);
        let _ = app.emit_to("main", "tray:screenshot", base64::engine::general_purpose::STANDARD.encode(png));
    });
}

/// Menu bar icon clicked: show the panel under it, or hide it.
fn toggle_tray(app: &tauri::AppHandle, rect: tauri::Rect) {
    let win = match app.get_webview_window("tray") {
        Some(w) => {
            if w.is_visible().unwrap_or(false) || now_ms().saturating_sub(TRAY_HIDDEN_AT.load(Ordering::Relaxed)) < 300 {
                let _ = w.hide();
                return;
            }
            w
        }
        None => match tauri::WebviewWindowBuilder::new(app, "tray", tauri::WebviewUrl::App("index.html".into()))
            .title("Crux")
            .inner_size(TRAY_WIDTH, 240.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .visible(false)
            .initialization_script("window.__CRUX_TRAY__ = true;")
            .build()
        {
            Ok(w) => w,
            Err(_) => return,
        },
    };
    let scale = win.scale_factor().unwrap_or(2.0);
    let icon = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    let width = TRAY_WIDTH * scale;
    let mut x = icon.x + size.width / 2.0 - width / 2.0;
    // Keep it on the screen the icon is on (the icon sits near the right edge).
    if let Ok(Some(m)) = app.monitor_from_point(icon.x, icon.y) {
        let (left, right) = (m.position().x as f64, m.position().x as f64 + m.size().width as f64);
        x = x.min(right - width - 8.0 * scale).max(left + 8.0 * scale);
    }
    let _ = win.set_position(tauri::PhysicalPosition::new(x, icon.y + size.height));
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("tray", "tray:shown", ());
}

/// Menu bar icon: a click opens the agents panel; right-click a small menu
/// (closing the window only hides Crux).
fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItemBuilder::with_id("tray-open", "Open Crux").build(app)?;
    let quick = MenuItemBuilder::with_id("tray-quick", "Quick Ask…").accelerator("Alt+Space").build(app)?;
    let shot = MenuItemBuilder::with_id("tray-shot", "Screenshot to Agent…").build(app)?;
    let updates = MenuItemBuilder::with_id("tray-updates", "Check for Updates…").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit Crux").accelerator("CmdOrCtrl+Q").build(app)?;
    let menu = MenuBuilder::new(app).item(&open).item(&quick).item(&shot).item(&updates).separator().item(&quit).build()?;
    let mut tray = TrayIconBuilder::with_id("crux")
        .tooltip("Crux")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main(app),
            "tray-quick" => toggle_quick(app),
            "tray-shot" => capture_screen(app),
            "tray-updates" => {
                show_main(app);
                let _ = app.emit_to("main", "menu:check-updates", ());
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                toggle_tray(tray.app_handle(), rect);
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
            tauri::WindowEvent::Focused(false) if window.label() == "tray" => {
                TRAY_HIDDEN_AT.store(now_ms(), Ordering::Relaxed);
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
                "check-updates" => {
                    show_main(app);
                    let _ = app.emit_to("main", "menu:check-updates", ());
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
            set_tray_chats,
            tray_chats,
            tray_fit,
            tray_action,
            screen_permission,
            request_screen_permission,
            request_folder_access,
            open_privacy,
            clear_notifications,
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
