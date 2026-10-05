// The desktop (Tauri) build serves the UI from tauri://, and the dev build
// from vite — in both cases the backend lives at a fixed local port, so all
// API and WS traffic goes to an absolute URL instead of relying on a proxy.
export const API_BASE = "http://localhost:8787";
export const WS_URL = "ws://localhost:8787/ws";

export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, init);
}
