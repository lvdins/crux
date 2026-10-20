//! Native browser panes: child WKWebViews docked inside the main window.
//!
//! The React UI owns the layout — it measures the panel placeholder and
//! tells us where the native view goes. Each workspace gets its own webview
//! (label `browser-<workspace>`), so logins and history stay per workspace
//! and survive tab switches. Remote pages get no IPC access: the capability
//! file only grants the `main` webview.

use serde::Serialize;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

#[derive(Clone, Serialize)]
struct NavEvent {
    label: String,
    url: String,
    loading: bool,
}

fn parse(url: &str) -> Result<Url, String> {
    url.parse::<Url>().map_err(|e| format!("bad url {url}: {e}"))
}

/// Create the pane on first use, otherwise move/resize it and show it.
#[tauri::command]
pub async fn browser_show(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_height: Option<f64>,
) -> Result<(), String> {
    let (w, h) = (width.max(1.0), height.max(1.0));
    if let Some(view) = app.get_webview(&label) {
        // macOS: one fire-and-forget frame update per call (this runs every
        // animation frame while panels slide); elsewhere use Tauri's API.
        #[cfg(target_os = "macos")]
        mac::place(&app, &view, x, y, w, h, viewport_height)?;
        #[cfg(not(target_os = "macos"))]
        {
            let _ = viewport_height;
            view.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
            view.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        }
        view.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    create(&app, &label, &url, x, y, w, h)?;
    #[cfg(target_os = "macos")]
    if let Some(view) = app.get_webview(&label) {
        mac::place(&app, &view, x, y, w, h, viewport_height)?;
    }
    Ok(())
}

/// Downloads in progress: their URL → where they're being saved.
static DOWNLOADS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, std::path::PathBuf>>> =
    std::sync::LazyLock::new(Default::default);

/// "Show in Finder" for a finished download (only files in ~/Downloads).
#[tauri::command]
pub fn browser_reveal_download(path: String) -> Result<(), String> {
    let file = std::path::PathBuf::from(&path);
    let downloads = std::path::Path::new(&crate::home_dir()).join("Downloads");
    if !file.starts_with(&downloads) || !file.exists() {
        return Err("Not a download".into());
    }
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&file).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// The page engine is the Mac's own WebKit (the installed Safari's), but an
/// embedded view leaves "Version/… Safari/…" out of its user agent, so sites
/// like Google Calendar call it an unsupported browser. Say what it is: the
/// same string Safari sends (Safari also keeps the OS part at 10_15_7).
fn safari_user_agent() -> String {
    static UA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    UA.get_or_init(|| {
        let version = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "/Applications/Safari.app/Contents/Info.plist", "CFBundleShortVersionString"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.'))
            .unwrap_or_else(|| "18.0".to_string());
        format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15")
    })
    .clone()
}

/// The write guard's policy as a page script (`window.__qlGuard = …`);
/// empty until the UI first sets it. New panes run it at document start.
static GUARD: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// Write guard on / off, its policy and the reply blocked writes get (see
/// netRecorder.js and server/src/guard.ts). Applies to every open page now
/// and to every page loaded later, in every browser pane.
#[tauri::command]
pub async fn guard_set(app: AppHandle, policy: serde_json::Value, reply: serde_json::Value) -> Result<(), String> {
    let mut policy = policy;
    policy.as_object_mut().ok_or("policy must be an object")?.insert("reply".into(), reply);
    let script = format!("window.__qlGuard = {policy};");
    let changed = {
        let mut current = GUARD.lock().unwrap();
        let changed = *current != script;
        *current = script.clone();
        changed
    };
    for (label, view) in app.webviews() {
        if !label.starts_with("browser-") {
            continue;
        }
        let _ = view.eval(&script);
        // Init scripts are fixed when a pane is made: add one so its next
        // pages start guarded too (the latest one added wins).
        #[cfg(target_os = "macos")]
        if changed {
            mac::add_start_script(&view, script.clone());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = changed;
    Ok(())
}

fn create(app: &AppHandle, label: &str, url: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let window = app.get_window("main").ok_or("main window missing")?;
    let events = app.clone();
    let downloads = app.clone();
    let event_label = label.to_string();
    let guard = GUARD.lock().unwrap().clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parse(url)?))
        // Web Inspector for the DevTools button (also makes the page
        // inspectable from Safari's Develop menu).
        .devtools(true)
        // Records fetch/XHR from document start for the Network panel.
        .initialization_script(include_str!("../../client/src/netRecorder.js"))
        // The write guard's current policy (read by the recorder per request).
        .initialization_script(if guard.is_empty() { "window.__qlGuard = null;" } else { &guard })
        .user_agent(&safari_user_agent())
        // Downloads go to ~/Downloads (wry picks the name, adding " (1)" when
        // taken); the window shows a notice when each one finishes.
        .on_download(move |_view, event| {
            use tauri::webview::DownloadEvent;
            let mut pending = DOWNLOADS.lock().unwrap();
            let (state, path) = match event {
                DownloadEvent::Requested { url, destination } => {
                    pending.insert(url.to_string(), destination.clone());
                    ("started", Some(destination.clone()))
                }
                // macOS doesn't report the path here: use the one from the request.
                DownloadEvent::Finished { url, success, .. } => (if success { "done" } else { "failed" }, pending.remove(url.as_str())),
                _ => return true,
            };
            let name = path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let _ = downloads.emit_to(
                "main",
                "browser:download",
                serde_json::json!({ "state": state, "name": name, "path": path.map(|p| p.to_string_lossy().to_string()) }),
            );
            true
        })
        .on_page_load(move |_view, payload| {
        let _ = events.emit_to(
            "main",
            "browser:nav",
            NavEvent {
                label: event_label.clone(),
                url: payload.url().to_string(),
                loading: matches!(payload.event(), PageLoadEvent::Started),
            },
        );
    });
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Make sure a pane exists (for the agent) without showing it; the UI
/// positions it when the Browser tab is visible. Returns true if created.
#[tauri::command]
pub async fn browser_ensure(app: AppHandle, label: String, url: String) -> Result<bool, String> {
    if app.get_webview(&label).is_some() {
        return Ok(false);
    }
    create(&app, &label, &url, 0.0, 0.0, 1280.0, 800.0)?;
    if let Some(view) = app.get_webview(&label) {
        view.hide().map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// Run an async function body in the page and return its (string) result.
/// `page_world` = run alongside the page's own scripts (sees its globals);
/// otherwise an isolated world that shares only the DOM.
#[tauri::command]
pub async fn browser_js(
    app: AppHandle,
    label: String,
    script: String,
    page_world: Option<bool>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let view = app.get_webview(&label).ok_or("browser not open")?;
    #[cfg(target_os = "macos")]
    {
        let rx = mac::run_js(&view, script, page_world.unwrap_or(false))?;
        // The element picker waits on the user, so it asks for longer.
        wait(rx, timeout_secs.unwrap_or(45).min(900)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (view, script, page_world, timeout_secs);
        Err("agent browser control is only implemented on macOS".into())
    }
}

/// PNG screenshot of the pane, base64-encoded.
#[tauri::command]
pub async fn browser_screenshot(app: AppHandle, label: String) -> Result<String, String> {
    let view = app.get_webview(&label).ok_or("browser not open")?;
    #[cfg(target_os = "macos")]
    {
        let rx = mac::snapshot(&view)?;
        wait(rx, 20).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = view;
        Err("screenshots are only implemented on macOS".into())
    }
}

async fn wait(rx: std::sync::mpsc::Receiver<Result<String, String>>, secs: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(secs))
            .unwrap_or_else(|_| Err("timed out waiting for the page".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
mod mac {
    use base64::Engine;
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSPoint, NSRect, NSSize, NSString};
    use objc2_web_kit::{WKContentWorld, WKUserScript, WKUserScriptInjectionTime, WKWebView};
    use std::sync::mpsc::{channel, Receiver};

    type Reply = Result<String, String>;

    /// Put a child view exactly over a box given in the main UI's CSS
    /// coordinates. wry flips y against its parent's height, which on macOS
    /// can include the title bar, so the view lands too high. Instead,
    /// measure the main webview in window coordinates and convert.
    // The main UI's WKWebView lives as long as the app; remember it so each
    // placement is a single main-thread hop with no waiting.
    static MAIN_WEBVIEW: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn main_webview(app: &tauri::AppHandle) -> Result<usize, String> {
        use std::sync::atomic::Ordering;
        use tauri::Manager;
        let cached = MAIN_WEBVIEW.load(Ordering::Relaxed);
        if cached != 0 {
            return Ok(cached);
        }
        let main = app.get_webview("main").ok_or("main webview missing")?;
        let (tx, rx) = channel::<usize>();
        main.with_webview(move |pv| {
            let _ = tx.send(pv.inner() as usize);
        })
        .map_err(|e| e.to_string())?;
        let ptr = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "timed out finding the main view".to_string())?;
        MAIN_WEBVIEW.store(ptr, Ordering::Relaxed);
        Ok(ptr)
    }

    /// Put a child view exactly over a box given in the main UI's CSS
    /// coordinates. wry flips y against its parent's height (which on macOS
    /// can include the title bar), so measure the main webview in window
    /// coordinates and convert instead.
    pub fn place(
        app: &tauri::AppHandle,
        child: &tauri::Webview,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        viewport_height: Option<f64>,
    ) -> Result<(), String> {
        let main_ptr = main_webview(app)?;
        child
            .with_webview(move |pv| unsafe {
                let main: &WKWebView = &*(main_ptr as *const WKWebView);
                let main_rect = main.convertRect_toView(main.bounds(), None);
                let wk: &WKWebView = &*(pv.inner() as *const WKWebView);
                // Window coordinates have their origin at the bottom-left. The
                // main view can extend under the title bar with its page
                // inset below it, so anchor on its bottom edge and the CSS
                // viewport height rather than on its top edge.
                let css_height = viewport_height.unwrap_or(main_rect.size.height);
                let target = NSRect::new(
                    NSPoint::new(main_rect.origin.x + x, main_rect.origin.y + css_height - y - h),
                    NSSize::new(w, h),
                );
                if let Some(parent) = wk.superview() {
                    wk.setFrame(parent.convertRect_fromView(target, None));
                }
            })
            .map_err(|e| e.to_string())
    }

    pub fn run_js(view: &tauri::Webview, body: String, page_world: bool) -> Result<Receiver<Reply>, String> {
        let (tx, rx) = channel::<Reply>();
        view.with_webview(move |pv| unsafe {
            let wk: &WKWebView = &*(pv.inner() as *const WKWebView);
            let mtm = MainThreadMarker::new_unchecked();
            let world = if page_world { WKContentWorld::pageWorld(mtm) } else { WKContentWorld::defaultClientWorld(mtm) };
            let tx = tx.clone();
            let done = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                let reply = if !error.is_null() {
                    Err((*error).localizedDescription().to_string())
                } else if result.is_null() {
                    Ok("null".to_string())
                } else {
                    let obj = &*result;
                    match obj.downcast_ref::<NSString>() {
                        Some(s) => Ok(s.to_string()),
                        None => Ok(format!("{obj:?}")),
                    }
                };
                let _ = tx.send(reply);
            });
            wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &NSString::from_str(&body),
                None,
                None,
                &world,
                Some(&done),
            );
        })
        .map_err(|e| e.to_string())?;
        Ok(rx)
    }

    /// A page-world script for every later page load of this pane (main frame).
    pub fn add_start_script(view: &tauri::Webview, source: String) {
        let _ = view.with_webview(move |pv| unsafe {
            let wk: &WKWebView = &*(pv.inner() as *const WKWebView);
            let mtm = MainThreadMarker::new_unchecked();
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                mtm.alloc(),
                &NSString::from_str(&source),
                WKUserScriptInjectionTime::AtDocumentStart,
                true,
            );
            wk.configuration().userContentController().addUserScript(&script);
        });
    }

    /// Undock Web Inspector into its own window (private _WKInspector API,
    /// guarded with respondsToSelector so a WebKit change can't crash us).
    pub fn detach_inspector(view: &tauri::Webview) {
        use objc2::{msg_send, sel};
        let _ = view.with_webview(|pv| unsafe {
            let wk = pv.inner() as *mut AnyObject;
            if wk.is_null() {
                return;
            }
            let wk = &*wk;
            let has_inspector: bool = msg_send![wk, respondsToSelector: sel!(_inspector)];
            if !has_inspector {
                return;
            }
            let inspector: *mut AnyObject = msg_send![wk, _inspector];
            if inspector.is_null() {
                return;
            }
            let inspector = &*inspector;
            let can_detach: bool = msg_send![inspector, respondsToSelector: sel!(detach)];
            if can_detach {
                let _: () = msg_send![inspector, detach];
            }
        });
    }

    pub fn snapshot(view: &tauri::Webview) -> Result<Receiver<Reply>, String> {
        let (tx, rx) = channel::<Reply>();
        view.with_webview(move |pv| unsafe {
            let wk: &WKWebView = &*(pv.inner() as *const WKWebView);
            let tx = tx.clone();
            let done = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let reply = (|| -> Reply {
                    if !error.is_null() {
                        return Err((*error).localizedDescription().to_string());
                    }
                    if image.is_null() {
                        return Err("empty snapshot".into());
                    }
                    let tiff = (*image).TIFFRepresentation().ok_or("no TIFF data")?;
                    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("bad bitmap")?;
                    let png = rep
                        .representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
                        .ok_or("PNG encode failed")?;
                    Ok(base64::engine::general_purpose::STANDARD.encode(png.to_vec()))
                })();
                let _ = tx.send(reply);
            });
            wk.takeSnapshotWithConfiguration_completionHandler(None, &done);
        })
        .map_err(|e| e.to_string())?;
        Ok(rx)
    }
}

/// Open or close Web Inspector for a pane. Returns whether it is now open.
#[tauri::command]
pub async fn browser_devtools(app: AppHandle, label: String) -> Result<bool, String> {
    let view = app.get_webview(&label).ok_or("browser not open")?;
    if view.is_devtools_open() {
        view.close_devtools();
        Ok(false)
    } else {
        // Hidden while WebKit docks-then-undocks the inspector, so the
        // temporary full-window stretch never shows; the UI re-places and
        // shows it again right after.
        view.hide().map_err(|e| e.to_string())?;
        view.open_devtools();
        // WebKit docks the inspector inside our window and resizes the page
        // to fit, wrecking the layout. Move it to its own window; retry while
        // the inspector finishes attaching. The UI re-places the page after.
        #[cfg(target_os = "macos")]
        for delay in [0u64, 100, 250, 500] {
            if delay > 0 {
                tokio_sleep(delay).await;
            }
            mac::detach_inspector(&view);
        }
        Ok(true)
    }
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

/// Page zoom for one browser tab (1.0 = actual size).
#[tauri::command]
pub async fn browser_zoom(app: AppHandle, label: String, scale: f64) -> Result<(), String> {
    let view = app.get_webview(&label).ok_or("No such browser tab")?;
    view.set_zoom(scale.clamp(0.3, 3.0)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_hide(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label) {
        view.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let view = app.get_webview(&label).ok_or("browser not open")?;
    view.navigate(parse(&url)?).map_err(|e| e.to_string())
}

/// back / forward / reload — plain history calls inside the page.
#[tauri::command]
pub async fn browser_action(app: AppHandle, label: String, action: String) -> Result<(), String> {
    let view = app.get_webview(&label).ok_or("browser not open")?;
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(format!("unknown action {action}")),
    };
    view.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Keep browser logins across restarts and updates.
/// - WebKit drops session cookies (no expiry) when the app quits, and many
///   sites (GitLab, Jira, the dashboard) log in with one: every few seconds,
///   give any session cookie a 30-day expiry so WebKit stores it on disk.
/// - Those sites send the cookie again as a session cookie on every page, so
///   at any moment some may be session-only again; an update that quits Crux
///   right then loses them. So Crux also keeps its own copy of the cookie
///   jar (`<CRUX_HOME>/browser-cookies.txt`, readable by you only) and, once a
///   browser pane exists after a restart, puts back any cookie that's missing
///   and reloads the panes. Logging out deletes the cookie, which the next
///   copy (≤ 5 s later) reflects, so a logout is not undone.
pub fn keep_logins(app: AppHandle) {
    use tauri::webview::cookie::{time::{Duration, OffsetDateTime}, Cookie, Expiration};
    let backup = cookie_backup_path();
    std::thread::spawn(move || {
        let mut restored = false;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            // All browser panes share one cookie store; any of them will do.
            let views: Vec<_> = app.webviews().into_iter().filter(|(l, _)| l.starts_with("browser-")).map(|(_, v)| v).collect();
            let Some(view) = views.first() else { continue };
            let Ok(cookies) = view.cookies() else { continue };
            let key = |c: &Cookie| format!("{}\t{}\t{}", c.name(), c.domain().unwrap_or("").trim_start_matches('.'), c.path().unwrap_or("/"));

            if !restored {
                restored = true;
                let have: std::collections::HashSet<String> = cookies.iter().map(|c| key(c)).collect();
                let now = OffsetDateTime::now_utc();
                let mut put_back = 0;
                for line in std::fs::read_to_string(&backup).unwrap_or_default().lines() {
                    let Ok(c) = Cookie::parse(line.to_string()) else { continue };
                    let live = match c.expires() {
                        Some(Expiration::DateTime(at)) => at > now,
                        _ => true,
                    };
                    if live && !have.contains(&key(&c)) && view.set_cookie(c.into_owned()).is_ok() {
                        put_back += 1;
                    }
                }
                if put_back > 0 {
                    for v in &views {
                        let _ = v.eval("location.reload()");
                    }
                    continue; // copy the jar on the next round, with the restored cookies in it
                }
            }

            let mut lines = Vec::with_capacity(cookies.len());
            for cookie in cookies {
                let mut kept = cookie.into_owned();
                let session = matches!(kept.expires(), None | Some(Expiration::Session)) && kept.max_age().is_none();
                if session {
                    kept.set_expires(OffsetDateTime::now_utc() + Duration::days(30));
                    let _ = view.set_cookie(kept.clone());
                }
                lines.push(kept.to_string());
            }
            write_private(&backup, &(lines.join("\n") + "\n"));
        }
    });
}

/// Logins imported from Arc / Chrome (Set-Cookie lines from the server's
/// browserImport.ts) go into the browser's cookie store, and into Crux's
/// copy of the jar so keep_logins puts them back if no pane is open yet.
#[tauri::command]
pub async fn browser_import_cookies(app: AppHandle, cookies: Vec<String>, reload: Option<bool>) -> Result<usize, String> {
    use tauri::webview::cookie::Cookie;
    // Lines whose domain-wide cookies say "Domain=..site" (the parser drops one dot).
    let (lines_in, parsed): (Vec<&String>, Vec<Cookie<'static>>) =
        cookies.iter().filter_map(|l| Cookie::parse(l.clone()).ok().map(|c| (l, c))).unzip();
    let view = app.webviews().into_iter().find(|(l, _)| l.starts_with("browser-")).map(|(_, v)| v);
    let mut set = 0;
    if let Some(view) = &view {
        for c in &parsed {
            if view.set_cookie(c.clone()).is_ok() {
                set += 1;
            }
        }
        // A lab account refresh (same login, new token) keeps the page as it is.
        if reload.unwrap_or(true) {
            for (label, v) in app.webviews() {
                if label.starts_with("browser-") {
                    let _ = v.eval("location.reload()");
                }
            }
        }
    }
    // Also in the backup jar (replacing the same name / domain / path).
    let backup = cookie_backup_path();
    let key = |c: &Cookie| format!("{}\t{}\t{}", c.name(), c.domain().unwrap_or("").trim_start_matches('.'), c.path().unwrap_or("/"));
    let incoming: std::collections::HashSet<String> = parsed.iter().map(|c| key(c)).collect();
    let mut lines: Vec<String> = std::fs::read_to_string(&backup)
        .unwrap_or_default()
        .lines()
        .filter(|l| Cookie::parse(l.to_string()).map(|c| !incoming.contains(&key(&c))).unwrap_or(false))
        .map(String::from)
        .collect();
    // The lines as given: to_string() would drop the extra dot again.
    lines.extend(lines_in.iter().map(|l| l.to_string()));
    write_private(&backup, &(lines.join("\n") + "\n"));
    Ok(if view.is_some() { set } else { parsed.len() })
}

fn cookie_backup_path() -> std::path::PathBuf {
    let home = crate::home_dir();
    std::env::var("CRUX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::Path::new(&home).join(".crux"))
        .join("browser-cookies.txt")
}

/// Write via a temp file + rename (never half a jar), mode 0600 on Unix
/// (Windows: the user profile folder is private already).
fn write_private(path: &std::path::Path, text: &str) {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let ok = opts.open(&tmp).and_then(|mut f| f.write_all(text.as_bytes()));
    if ok.is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}
