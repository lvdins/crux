// The desktop (Tauri) build serves the UI from tauri://, and the dev build
// from vite — in both cases the backend lives at a fixed local port, so all
// API and WS traffic goes to an absolute URL instead of relying on a proxy.
// Served by the Crux server itself (http://localhost:<port>): talk to
// that origin. Vite dev (:5180, app:fresh :5181) and the desktop shell
// (tauri://) talk to the server port directly.
const sameOrigin =
  typeof location !== "undefined" && location.protocol.startsWith("http") && !import.meta.env.DEV;
// `npm run app:dev` builds with VITE_CRUX_PORT=8788 so it talks to its own server.
const PORT = import.meta.env.VITE_CRUX_PORT || "8787";
// 127.0.0.1, not localhost: the server listens on IPv4 loopback only.
export const API_BASE = sameOrigin ? location.origin : `http://127.0.0.1:${PORT}`;
export const WS_URL = `${API_BASE.replace(/^http/, "ws")}/ws`;

export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, init);
}
