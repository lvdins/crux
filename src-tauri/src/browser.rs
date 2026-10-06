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
) -> Result<(), String> {
    let (w, h) = (width.max(1.0), height.max(1.0));
    if let Some(view) = app.get_webview(&label) {
        view.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        view.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("main window missing")?;
    let events = app.clone();
    let event_label = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parse(&url)?)).on_page_load(move |_view, payload| {
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
