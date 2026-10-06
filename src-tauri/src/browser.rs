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
        view.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        view.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        mac::place(&app, &view, x, y, w, h, viewport_height)?;
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

fn create(app: &AppHandle, label: &str, url: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let window = app.get_window("main").ok_or("main window missing")?;
    let events = app.clone();
    let event_label = label.to_string();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parse(url)?)).on_page_load(move |_view, payload| {
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
pub async fn browser_js(app: AppHandle, label: String, script: String, page_world: Option<bool>) -> Result<String, String> {
    let view = app.get_webview(&label).ok_or("browser not open")?;
    #[cfg(target_os = "macos")]
    {
        let rx = mac::run_js(&view, script, page_world.unwrap_or(false))?;
        wait(rx, 45).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (view, script, page_world);
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
    use objc2_web_kit::{WKContentWorld, WKWebView};
    use std::sync::mpsc::{channel, Receiver};

    type Reply = Result<String, String>;

    /// Put a child view exactly over a box given in the main UI's CSS
    /// coordinates. wry flips y against its parent's height, which on macOS
    /// can include the title bar, so the view lands too high. Instead,
    /// measure the main webview in window coordinates and convert.
    pub fn place(
        app: &tauri::AppHandle,
        child: &tauri::Webview,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        viewport_height: Option<f64>,
    ) -> Result<(), String> {
        use tauri::Manager;
        let main = app.get_webview("main").ok_or("main webview missing")?;
        let (tx, rx) = channel::<NSRect>();
        main.with_webview(move |pv| unsafe {
            let wk: &WKWebView = &*(pv.inner() as *const WKWebView);
            let _ = tx.send(wk.convertRect_toView(wk.bounds(), None));
        })
        .map_err(|e| e.to_string())?;
        let main_rect = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "timed out measuring the main view".to_string())?;
        child
            .with_webview(move |pv| unsafe {
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
