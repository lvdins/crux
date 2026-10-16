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

/// The user's home folder: HOME on macOS / Linux, USERPROFILE on Windows.
pub(crate) fn home_dir() -> String {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| "/".into())
}

/// The bundled Node binary in ql-runtime (scripts/bundle-server.mjs).
#[cfg(windows)]
const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN: &str = "node";

/// Windows: no console window for a helper process (the app has none).
fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// Windows has no SIGTERM: ask the server over HTTP to save every chat and quit.
#[cfg(not(unix))]
fn ask_server_to_quit() {
    use std::io::Write;
    let addr = format!("127.0.0.1:{}", server_port());
    if let Ok(mut s) = TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(300)) {
        let _ = s.write_all(b"POST /api/quit HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
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
        .filter(|root| root.join(NODE_BIN).exists() && root.join("server/dist/index.mjs").exists());

    let home = crate::home_dir();
    let mut cmd = match bundled {
        Some(root) => {
            let mut c = Command::new(root.join(NODE_BIN));
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
    hide_console(&mut cmd);
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

/// Default macOS menu plus View → Toggle Sidebar (⌘S) / Browser (⌘B). A menu accelerator
/// fires even when a terminal or a native browser pane has keyboard focus.
#[cfg(target_os = "macos")]
fn install_menu(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, SubmenuBuilder};
    let toggle = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let toggle_right = MenuItemBuilder::with_id("toggle-right", "Browser")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    // Browser menu: the usual browser shortcuts for Crux's browser. Menu
    // accelerators fire even while the web page has keyboard focus.
    let mut browser = SubmenuBuilder::new(app, "Browser");
    for (i, (id, label, keys)) in BROWSER_MENU.iter().enumerate() {
        if [4, 7, 10, 13, 16].contains(&i) {
            browser = browser.separator();
        }
        browser = browser.item(&MenuItemBuilder::with_id(format!("browser:{id}"), *label).accelerator(*keys).build(app)?);
    }
    for n in 1..=9 {
        let label = if n == 9 { "Last Tab".to_string() } else { format!("Tab {n}") };
        browser = browser.item(&MenuItemBuilder::with_id(format!("browser:tab-{n}"), label).accelerator(format!("CmdOrCtrl+{n}")).build(app)?);
    }
    let browser = browser.build()?;
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
    // ⌘W closes the browser tab now (Crux's window when no browser is shown):
    // drop the stock Close Window item that also wants ⌘W.
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item {
            for entry in sub.items()? {
                if let MenuItemKind::Predefined(p) = &entry {
                    if p.text()?.starts_with("Close") {
                        sub.remove(&entry)?;
                    }
                }
            }
        }
    }
    menu.insert(&browser, 3)?;
    if !placed {
        menu.append(&SubmenuBuilder::new(app, "View").item(&toggle).item(&toggle_right).item(&report).item(&search).build()?)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

/// Browser menu (id, label, shortcut); Tab 1–9 are added after these.
#[cfg(target_os = "macos")]
const BROWSER_MENU: &[(&str, &str, &str)] = &[
    ("new-tab", "New Tab", "CmdOrCtrl+T"),
    ("reopen", "Reopen Closed Tab", "CmdOrCtrl+Shift+T"),
    ("close", "Close Tab", "CmdOrCtrl+W"),
    ("url", "Open Location…", "CmdOrCtrl+L"),
    ("reload", "Reload Page", "CmdOrCtrl+R"),
    ("back", "Back", "CmdOrCtrl+["),
    ("forward", "Forward", "CmdOrCtrl+]"),
    ("find", "Find…", "CmdOrCtrl+F"),
    ("bookmark", "Bookmark This Page", "CmdOrCtrl+D"),
    ("duplicate", "Duplicate Tab", "CmdOrCtrl+Shift+D"),
    ("zoom-in", "Zoom In", "CmdOrCtrl+="),
    ("zoom-out", "Zoom Out", "CmdOrCtrl+-"),
    ("zoom-reset", "Actual Size", "CmdOrCtrl+0"),
    ("next-tab", "Show Next Tab", "CmdOrCtrl+Shift+]"),
    ("prev-tab", "Show Previous Tab", "CmdOrCtrl+Shift+["),
    ("next-tab-ctrl", "Next Tab", "Ctrl+Tab"),
    ("prev-tab-ctrl", "Previous Tab", "Ctrl+Shift+Tab"),
];

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    // set_focus alone doesn't bring Crux in front of the app you were in
    // (e.g. after the screenshot crosshair hands focus back to it).
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            #[allow(deprecated)]
            objc2_app_kit::NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        }
    });
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

/// Screen Recording was asked for since Crux started. macOS applies a grant
/// only after Crux restarts, so until then the check still says no: asking
/// again would just reopen System Settings with the switch already on.
static SCREEN_ASKED: AtomicBool = AtomicBool::new(false);

/// Screen Recording: "granted", "restart" (asked this run, so it's likely on
/// but needs a restart), or "unknown" (not asked yet).
#[tauri::command]
fn screen_permission() -> &'static str {
    #[cfg(target_os = "macos")]
    if unsafe { CGPreflightScreenCaptureAccess() } {
        return "granted";
    }
    // No such permission on Linux / Windows.
    #[cfg(not(target_os = "macos"))]
    return "granted";
    #[allow(unreachable_code)]
    if SCREEN_ASKED.load(Ordering::Relaxed) { "restart" } else { "unknown" }
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
        SCREEN_ASKED.store(true, Ordering::Relaxed);
        let granted = unsafe { CGRequestScreenCaptureAccess() };
        if !granted {
            open_privacy("ScreenCapture".into());
        }
        granted
    }
    #[cfg(not(target_os = "macos"))]
    true
}

/// Quit and reopen Crux (a new Screen Recording grant needs it). Async, so it
/// goes through the normal exit: the server saves every chat to reopen.
#[tauri::command]
async fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Touch Documents, Desktop and Downloads so macOS asks for each now (repos
/// and agents' files live there) instead of mid-task. Which ones Crux can read.
#[tauri::command]
async fn request_folder_access() -> Vec<(String, bool)> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = crate::home_dir();
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
    #[cfg(not(target_os = "macos"))]
    return true;
    #[allow(unreachable_code)]
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
    // ⌥Space on macOS; Alt+Space opens the window menu on Linux / Windows.
    #[cfg(target_os = "macos")]
    return Shortcut::new(Some(Modifiers::ALT), Code::Space);
    #[cfg(not(target_os = "macos"))]
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}

/// Agent chats for the menu bar panel, as the main window last sent them (JSON).
static TRAY_CHATS: Mutex<String> = Mutex::new(String::new());
/// When the panel last hid on losing focus: a click on the menu bar icon
/// blurs it first, and that same click must not open it again.
static TRAY_HIDDEN_AT: AtomicU64 = AtomicU64::new(0);
const TRAY_WIDTH: f64 = 380.0;
/// Bottom edge the panel grows up from, when it opened above a bottom taskbar.
static TRAY_BOTTOM: Mutex<Option<f64>> = Mutex::new(None);

/// Where the panel goes when the icon's position is unknown (Linux sends no
/// tray click events): the top-right corner of the main screen.
fn tray_anchor(app: &tauri::AppHandle) -> Option<tauri::Rect> {
    if let Some(rect) = app.tray_by_id("crux").and_then(|t| t.rect().ok().flatten()) {
        return Some(rect);
    }
    let m = app.primary_monitor().ok().flatten()?;
    let scale = m.scale_factor();
    let (x, y) = (m.position().x as f64 + m.size().width as f64 - 60.0 * scale, m.position().y as f64);
    Some(tauri::Rect {
        position: tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32)),
        size: tauri::Size::Physical(tauri::PhysicalSize::new((40.0 * scale) as u32, (32.0 * scale) as u32)),
    })
}

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
        let h = height.clamp(60.0, 620.0);
        let _ = w.set_size(tauri::LogicalSize::new(TRAY_WIDTH, h));
        // Opened above a bottom taskbar: grow upward, keep the bottom edge.
        if let Some(bottom) = *TRAY_BOTTOM.lock().unwrap() {
            let scale = w.scale_factor().unwrap_or(1.0);
            if let Ok(pos) = w.outer_position() {
                let _ = w.set_position(tauri::PhysicalPosition::new(pos.x as f64, bottom - h * scale));
            }
        }
    }
}

/// Panel buttons: a chat, a screenshot, or open / quick ask / updates / quit.
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
        "capture" => capture_screen(&app),
        "open" => show_main(&app),
        "quick" => toggle_quick(&app),
        "updates" => {
            show_main(&app);
            let _ = app.emit_to("main", "menu:check-updates", ());
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// The panel window (made on first use; the same client renders TrayPanel).
fn tray_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("tray") {
        return Some(w);
    }
    tauri::WebviewWindowBuilder::new(app, "tray", tauri::WebviewUrl::App("index.html".into()))
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
        .ok()
}

/// Put the panel under the menu bar icon (kept on that screen) and show it.
fn place_tray(app: &tauri::AppHandle, win: &tauri::WebviewWindow, rect: tauri::Rect, focus: bool) {
    let scale = win.scale_factor().unwrap_or(2.0);
    let icon = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    let width = TRAY_WIDTH * scale;
    let mut x = icon.x + size.width / 2.0 - width / 2.0;
    let mut y = icon.y + size.height;
    *TRAY_BOTTOM.lock().unwrap() = None;
    if let Ok(Some(m)) = app.monitor_from_point(icon.x, icon.y) {
        let (left, right) = (m.position().x as f64, m.position().x as f64 + m.size().width as f64);
        x = x.min(right - width - 8.0 * scale).max(left + 8.0 * scale);
        // Taskbar at the bottom (Windows): open above the icon instead.
        if icon.y > m.position().y as f64 + m.size().height as f64 / 2.0 {
            let bottom = icon.y - 4.0 * scale;
            let h = win.outer_size().map(|s| s.height as f64).unwrap_or(240.0 * scale);
            *TRAY_BOTTOM.lock().unwrap() = Some(bottom);
            y = bottom - h;
        }
    }
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.show();
    if focus {
        let _ = win.set_focus();
    }
    let _ = app.emit_to("tray", "tray:shown", ());
}

/// Menu bar icon clicked: show the panel under it, or hide it.
fn toggle_tray(app: &tauri::AppHandle, rect: tauri::Rect) {
    let Some(win) = tray_window(app) else { return };
    if win.is_visible().unwrap_or(false) || now_ms().saturating_sub(TRAY_HIDDEN_AT.load(Ordering::Relaxed)) < 300 {
        let _ = win.hide();
        return;
    }
    place_tray(app, &win, rect, true);
}

/// Screenshot to agent with Screen Recording allowed: the crosshair right
/// away (drag a box, Esc cancels) and the image goes straight to the main
/// window. Without the permission the panel asks you to press ⌘⇧4 instead
/// (see TrayPanel), so this never triggers the macOS prompt.
fn capture_screen(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return;
    }
    // Crux stays out of the way while you pick the area (hiding the panel can
    // otherwise bring its main window forward, over what you want to capture);
    // show_main brings it back once the screenshot is taken.
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            objc2_app_kit::NSApplication::sharedApplication(mtm).hide(None);
        }
    });
    let app = app.clone();
    std::thread::spawn(move || {
        use base64::Engine;
        #[cfg(target_os = "macos")]
        std::thread::sleep(std::time::Duration::from_millis(150));
        let file = std::env::temp_dir().join(format!("crux-shot-{}.png", now_ms()));
        region_capture(&file);
        // No file: cancelled. Crux comes back where it was, behind your app.
        let Ok(png) = std::fs::read(&file) else {
            #[cfg(target_os = "macos")]
            let _ = app.run_on_main_thread(|| {
                if let Some(mtm) = objc2::MainThreadMarker::new() {
                    objc2_app_kit::NSApplication::sharedApplication(mtm).unhideWithoutActivation();
                }
            });
            return;
        };
        let _ = std::fs::remove_file(&file);
        show_main(&app);
        let _ = app.emit_to("main", "tray:screenshot", base64::engine::general_purpose::STANDARD.encode(png));
    });
}

/// Drag a box, save it to `file` (no file: cancelled).
#[cfg(target_os = "macos")]
fn region_capture(file: &std::path::Path) {
    let _ = Command::new("/usr/sbin/screencapture").args(["-i", "-x"]).arg(file).status();
}

/// Linux: whichever region screenshot tool the desktop has.
#[cfg(target_os = "linux")]
fn region_capture(file: &std::path::Path) {
    const PICK: &str = r#"f="$1"
if command -v gnome-screenshot >/dev/null; then gnome-screenshot -a -f "$f"
elif command -v spectacle >/dev/null; then spectacle -b -n -r -o "$f"
elif command -v grim >/dev/null && command -v slurp >/dev/null; then g=$(slurp) && grim -g "$g" "$f"
elif command -v flameshot >/dev/null; then flameshot gui --raw > "$f"
elif command -v maim >/dev/null; then maim -s "$f"
elif command -v scrot >/dev/null; then scrot -s "$f"
elif command -v import >/dev/null; then import "$f"
fi"#;
    let _ = Command::new("sh").args(["-c", PICK, "crux-capture"]).arg(file).status();
    // An empty file (cancelled flameshot) is no screenshot.
    if std::fs::metadata(file).map(|m| m.len() == 0).unwrap_or(false) {
        let _ = std::fs::remove_file(file);
    }
}

/// Windows: the Snipping Tool overlay (Win+Shift+S) puts the snip on the
/// clipboard; wait for it (clipboard cleared first) and save it as a PNG.
#[cfg(target_os = "windows")]
fn region_capture(file: &std::path::Path) {
    const SNIP: &str = r#"Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Clipboard]::Clear()
Start-Process 'ms-screenclip:'
for ($i = 0; $i -lt 240; $i++) {
  Start-Sleep -Milliseconds 250
  if ([Windows.Forms.Clipboard]::ContainsImage()) {
    [Windows.Forms.Clipboard]::GetImage().Save($env:CRUX_SHOT, [Drawing.Imaging.ImageFormat]::Png)
    break
  }
}"#;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-STA", "-Command", SNIP]).env("CRUX_SHOT", file);
    hide_console(&mut cmd);
    let _ = cmd.status();
}

/// Menu bar icon: a click opens the agents panel; right-click a small menu
/// (closing the window only hides Crux).
fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    // Linux sends no tray clicks: the panel is a menu item there.
    let agents = MenuItemBuilder::with_id("tray-panel", "Agents…").build(app)?;
    let open = MenuItemBuilder::with_id("tray-open", "Open Crux").build(app)?;
    let quick = MenuItemBuilder::with_id("tray-quick", "Quick Ask…").accelerator("Alt+Space").build(app)?;
    let updates = MenuItemBuilder::with_id("tray-updates", "Check for Updates…").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit Crux").accelerator("CmdOrCtrl+Q").build(app)?;
    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "linux") {
        menu = menu.item(&agents);
    }
    let menu = menu.item(&open).item(&quick).item(&updates).separator().item(&quit).build()?;
    let mut tray = TrayIconBuilder::with_id("crux")
        .tooltip("Crux")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main(app),
            "tray-quick" => toggle_quick(app),
            "tray-updates" => {
                show_main(app);
                let _ = app.emit_to("main", "menu:check-updates", ());
            }
            "tray-quit" => app.exit(0),
            "tray-panel" => {
                if let Some(rect) = tray_anchor(app) {
                    toggle_tray(app, rect);
                }
            }
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
    // WebKitGTK's DMA-BUF renderer leaves the window blank on some GPU
    // drivers (NVIDIA); the plain renderer works everywhere.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
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
            // macOS menu bar (⌘S, ⌘B, …). On Linux / Windows the page handles
            // Ctrl+Shift+S / B / K itself, so terminals keep their Ctrl keys.
            #[cfg(target_os = "macos")]
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
                id if id.starts_with("browser:") => {
                    let op = &id["browser:".len()..];
                    // Quick Ask / the menu bar panel focused: ⌘W closes that, the
                    // rest is for the main window. (Asking whether "main" is
                    // focused is unreliable while a browser page has focus.)
                    let other = app
                        .webview_windows()
                        .into_iter()
                        .find(|(label, w)| label != "main" && w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
                    if let Some((_, w)) = other {
                        if op == "close" {
                            let _ = w.hide();
                        }
                        return;
                    }
                    // Keys typed next (address bar, find) go to Crux, not the web page.
                    if matches!(op, "new-tab" | "url" | "find") {
                        if let Some(w) = app.get_webview("main") {
                            let _ = w.set_focus();
                        }
                    }
                    let _ = app.emit_to("main", "menu:browser", op.to_string());
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
            browser::browser_import_cookies,
            browser::browser_zoom,
            browser::browser_reveal_download,
            browser::browser_devtools,
            set_background,
            set_tray_title,
            set_tray_chats,
            tray_chats,
            tray_fit,
            tray_action,
            screen_permission,
            request_screen_permission,
            restart_app,
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
                    #[cfg(unix)]
                    let _ = Command::new("kill").args(["-TERM", &child.id().to_string()]).status();
                    #[cfg(not(unix))]
                    ask_server_to_quit();
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
