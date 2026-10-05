#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

/// Project root, resolved at compile time. SuperQA is a local tool whose
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
            eprintln!("failed to start SuperQA server: {err}");
            None
        }
    }
}

fn main() {
    let server: Mutex<Option<Child>> = Mutex::new(spawn_server());

    tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("error building SuperQA")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = server.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
