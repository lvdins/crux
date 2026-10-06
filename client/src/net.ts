// The desktop (Tauri) build serves the UI from tauri://, and the dev build
// from vite — in both cases the backend lives at a fixed local port, so all
// API and WS traffic goes to an absolute URL instead of relying on a proxy.
// Served by the QualityLab server itself (http://localhost:<port>): talk to
// that origin. Vite dev (:5180) and the desktop shell (tauri://) use 8787.
const sameOrigin = typeof location !== "undefined" && location.protocol.startsWith("http") && location.port !== "5180";
export const API_BASE = sameOrigin ? location.origin : "http://localhost:8787";
export const WS_URL = `${API_BASE.replace(/^http/, "ws")}/ws`;

export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, init);
}
