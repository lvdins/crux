import { useSyncExternalStore } from "react";
import { API_BASE, api } from "./net";
import { notify } from "./notify";

/**
 * Local extensions (server/src/extensions.ts): client.mjs from each one is
 * imported into the main window and its `activate(crux)` runs once. An
 * extension may add views: a sidebar item plus a pane it renders itself.
 * This is all the API an extension gets from Crux.
 */
export interface ExtensionView {
  /** Unique within the extension. */
  id: string;
  label: string;
  /** Inline SVG markup, 12×12, stroke="currentColor". */
  icon?: string;
  /** Renders into `el`; the returned function runs when the pane closes. */
  mount: (el: HTMLElement) => void | (() => void);
  /** Count shown on the sidebar item, like Home's. */
  badge?: ExtensionBadge | null;
  /** Shows an × on the sidebar item (on hover); the extension decides what closing means. */
  onClose?: () => void;
}

export interface ExtensionBadge {
  count: number;
  tone?: "warn" | "fail";
}

export interface CruxExtensionApi {
  name: string;
  /** http base of the extension's files, e.g. for a stylesheet: `${base}/style.css`. */
  base: string;
  /** Absolute URL of /api/ext/<name>, for tools outside the page (e.g. curl in an agent prompt). */
  apiUrl: string;
  /** fetch() against /api/ext/<name><path>. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  notify: (title: string, body: string) => Promise<void>;
  addView: (view: ExtensionView) => void;
  removeView: (id: string) => void;
  /** Switch the main window to this view. */
  showView: (id: string) => void;
  /** Set or clear (null / count 0) the sidebar badge of one of this extension's views. */
  setBadge: (id: string, badge: ExtensionBadge | null) => void;
  /** Start a new Claude chat with this prompt, in the workspace named by key or label (else the first one). Resolves to its chat key. */
  askAgent: (prompt: string, opts?: { workspace?: string; title?: string }) => Promise<string | undefined>;
  /** Switch to a chat (a key from askAgent). */
  openChat: (chat: string) => void;
  /** The user's workspaces. */
  workspaces: () => { key: string; label: string }[];
  /** Open an http(s) link the way Crux does: its Browser view when on, else the system browser. */
  openUrl: (url: string) => void;
}

export interface RegisteredView extends ExtensionView {
  /** The app's view key: `ext:<name>:<id>`. */
  key: string;
}

interface ExtensionModule {
  /** May return a cleanup, run before the extension reloads. */
  activate?: (crux: CruxExtensionApi) => void | (() => void);
}

interface ExtensionListing {
  name: string;
  client: boolean;
  version: number;
}

let views: RegisteredView[] = [];
/** True once every extension's activate has run (a saved ext view that's gone can then be left). */
let settled = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
let showHandler: (key: string) => void = () => {};
export interface ExtensionHost {
  ask: (prompt: string, opts: { workspace?: string; title?: string }) => Promise<string | undefined>;
  openChat: (chat: string) => void;
  workspaces: () => { key: string; label: string }[];
  openUrl: (url: string) => void;
}
let host: ExtensionHost = { ask: async () => undefined, openChat: () => {}, workspaces: () => [], openUrl: (url) => window.open(url, "_blank", "noopener") };

export const isExtensionView = (view: string) => view.startsWith("ext:");

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The registered views; `settled` once all extensions have loaded. */
export function useExtensionViews(): { views: RegisteredView[]; settled: boolean } {
  const list = useSyncExternalStore(subscribe, () => views);
  const done = useSyncExternalStore(subscribe, () => settled);
  return { views: list, settled: done };
}

/** App passes its setView so extensions can open their views. */
export function onShowExtensionView(fn: (key: string) => void) {
  showHandler = fn;
}

/** App passes how to start and open chats and list workspaces. */
export function setExtensionHost(h: ExtensionHost) {
  host = h;
}

function apiFor(name: string, version: number): CruxExtensionApi {
  const keyOf = (id: string) => `ext:${name}:${id}`;
  return {
    name,
    // Versioned: a reload changes the URL of every file it loads.
    base: `${API_BASE}/ext/${name}@${version}`,
    fetch: (path, init) => api(`/api/ext/${name}${path}`, init),
    notify,
    addView: (view) => {
      const key = keyOf(view.id);
      views = [...views.filter((v) => v.key !== key), { ...view, key }];
      changed();
    },
    removeView: (id) => {
      views = views.filter((v) => v.key !== keyOf(id));
      changed();
    },
    showView: (id) => showHandler(keyOf(id)),
    apiUrl: `${API_BASE}/api/ext/${name}`,
    askAgent: (prompt, opts = {}) => host.ask(prompt, opts),
    openChat: (chat) => host.openChat(chat),
    workspaces: () => host.workspaces(),
    openUrl: (url) => {
      if (/^https?:\/\//i.test(url)) host.openUrl(url);
    },
    setBadge: (id, badge) => {
      const key = keyOf(id);
      views = views.map((v) => (v.key === key ? { ...v, badge } : v));
      changed();
    },
  };
}

/** What's running per extension: its version and the cleanup its activate returned. */
const active = new Map<string, { version: number; cleanup?: () => void }>();

function deactivate(name: string) {
  try {
    active.get(name)?.cleanup?.();
  } catch (err) {
    console.warn(`extension ${name}: cleanup failed:`, err);
  }
  active.delete(name);
}

/** Brings the running extensions in line with the server's list: (re)activates changed ones, drops removed ones. */
async function sync(): Promise<void> {
  let list: ExtensionListing[] = [];
  try {
    list = await (await api("/api/extensions")).json();
  } catch {
    return;
  }
  const wanted = new Map(list.filter((e) => e.client).map((e) => [e.name, e.version]));
  for (const name of [...active.keys()]) if (!wanted.has(name)) {
    deactivate(name);
    views = views.filter((v) => !v.key.startsWith(`ext:${name}:`));
  }
  for (const [name, version] of wanted) {
    if (active.get(name)?.version === version) continue;
    let mod: ExtensionModule;
    try {
      mod = await import(/* @vite-ignore */ `${API_BASE}/ext/${name}@${version}/client.mjs`);
    } catch (err) {
      console.warn(`extension ${name}:`, err);
      continue; // keep the running version
    }
    // Swap in one step, so an open view is replaced rather than closed.
    deactivate(name);
    const kept = views;
    views = views.filter((v) => !v.key.startsWith(`ext:${name}:`));
    try {
      const cleanup = mod.activate?.(apiFor(name, version));
      active.set(name, { version, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    } catch (err) {
      console.warn(`extension ${name}:`, err);
      views = kept;
    }
  }
  changed();
}

/** Main window: runs each extension's `activate`. Missing or broken ones are skipped. */
export async function activateExtensions(): Promise<void> {
  await sync();
  settled = true;
  changed();
}

/** The server saw an extension's files change: reload what changed. */
export const reloadExtensions = sync;
