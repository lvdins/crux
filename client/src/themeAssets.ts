import { api, API_BASE } from "./net";

/**
 * Backgrounds live in ~/.crux/themes/assets. The desktop app reads them
 * straight from disk through Tauri's asset protocol (tauri.conf.json scopes
 * it to that folder); a plain browser (vite dev) gets them from the server.
 */
const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let assetsDir: string | null = null;
let convert: ((path: string) => string) | null = null;

/** Resolves once the asset folder is known (assetUrl falls back to the server until then). */
export const themeAssetsReady: Promise<void> = (async () => {
  if (!IN_TAURI) return;
  try {
    const [info, core] = await Promise.all([
      api("/api/themes/dir").then((r) => r.json() as Promise<{ assets: string; assetProtocol: boolean }>),
      import("@tauri-apps/api/core"),
    ]);
    if (!info.assetProtocol) return; // a CRUX_HOME outside the allowed scope (app:fresh)
    assetsDir = info.assets;
    convert = core.convertFileSrc;
  } catch {
    /* keep the server route */
  }
})();

/** URL for a background file by name (a plain file name, as saved in Appearance). */
export function assetUrl(name: string): string {
  if (assetsDir && convert) return convert(`${assetsDir}/${name}`);
  return `${API_BASE}/api/themes/assets/${encodeURIComponent(name)}`;
}
