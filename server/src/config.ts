import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRUX_HOME, DEFAULT_HOME, rootPath } from "./paths.js";
import type { Appearance } from "./themes.js";

export type RepoKind = "mkdocs" | "playwright" | "pytest" | "frontend" | "backend" | "generic";

export interface RepoConfig {
  label: string;
  path: string;
  kind: RepoKind;
  pinned?: boolean;
  color?: string;
}

export interface CruxConfig {
  repos: Record<string, RepoConfig>;
  agent: { permissionMode: "acceptEdits" | "default" | "bypassPermissions" };
  preview: { port: number };
  /** Set once the first-run intro and setup guide are finished or skipped. */
  onboarded?: boolean;
  /** What the user asked Crux to call them (first-run name step). */
  userName?: string;
  settings?: Partial<Settings>;
}

/** Which parts of Crux are on. A mode is a preset; each toggle can differ. */
export interface Settings {
  mode: "qa" | "regular";
  // workspace panel tabs
  docPreview: boolean;
  tests: boolean;
  coverage: boolean;
  pipelines: boolean;
  browser: boolean;
  network: boolean;
  picker: boolean;
  // sidebar views (and the Connections view's own tabs)
  connections: boolean;
  connCoverage: boolean;
  connGraph: boolean;
  jira: boolean;
  writeGuard: boolean;
  // chats and notifications (not part of a mode)
  defaultChat: "pick" | "claude" | "codex" | "shell";
  askChatName: boolean;
  confirmClose: boolean;
  notifyAgent: boolean;
  notifyPipeline: boolean;
  /** Closing the window hides Crux to the menu bar (desktop app). */
  keepRunning: boolean;
  /** ⌥Space from any app opens the quick-ask box (desktop app). */
  quickAsk: boolean;
  /** Start on the Home screen instead of the last view. */
  openHome: boolean;
  /** The session tab bar lists every workspace's chats (off: this workspace's). */
  tabsAll: boolean;
  /** Sidebar → Sessions (past sessions of every workspace). */
  sessionsView: boolean;
  /** Jira project key bugs are filed in (blank: the agent asks). */
  jiraProject: string;
  /** Write guard: hosts whose writes it answers (default DEFAULT_GUARD_HOSTS). */
  guardHosts?: string[];
  /** Settings → Appearance (see themes.ts). Absent: Crux's own look. */
  appearance?: Appearance;
}

/** Tabs and views: a mode turns these on or off. */
export const VIEW_KEYS = [
  "docPreview", "tests", "coverage", "pipelines", "browser", "network", "picker",
  "connections", "connCoverage", "connGraph", "jira",
  "writeGuard",
] as const;
/** Personal preferences: kept when the mode changes. */
export const PREF_KEYS = ["askChatName", "confirmClose", "notifyAgent", "notifyPipeline", "keepRunning", "quickAsk", "openHome", "tabsAll", "sessionsView"] as const;
export const SETTING_KEYS = [...VIEW_KEYS, ...PREF_KEYS] as const;
export const DEFAULT_CHATS = ["pick", "claude", "codex", "shell"] as const;

const PREFS = { jiraProject: "", defaultChat: "pick", askChatName: true, confirmClose: true, notifyAgent: true, notifyPipeline: true, keepRunning: true, quickAsk: true, openHome: true, tabsAll: true, sessionsView: true } as const;
const views = (on: boolean) => Object.fromEntries(VIEW_KEYS.map((k) => [k, on])) as Record<(typeof VIEW_KEYS)[number], boolean>;
export const MODE_PRESETS: Record<Settings["mode"], Settings> = {
  qa: { mode: "qa", ...views(true), ...PREFS },
  regular: { mode: "regular", ...views(false), ...PREFS },
};

/**
 * The in-app browser (panes, the agents' crux-browser tools, ⌘⇧C, the
 * Browser view) is built on macOS's WebKit: elsewhere it's always off.
 */
export const BROWSER_SUPPORTED = process.platform === "darwin";
const NO_BROWSER = { browser: false, network: false, picker: false, jira: false, writeGuard: false } as const;

/** Saved settings over the mode's preset (existing users default to QA). */
export function currentSettings(): Settings {
  const { qaPanels, ...saved } = (config.settings ?? {}) as Partial<Settings> & { qaPanels?: boolean };
  // Before 0.1.11 one "QA panels" switch covered these tabs.
  const legacy = qaPanels === false ? { docPreview: false, tests: false, coverage: false, pipelines: false } : {};
  return { ...MODE_PRESETS[saved.mode ?? "qa"], ...legacy, ...saved, ...(BROWSER_SUPPORTED ? {} : NO_BROWSER) };
}

// Bundled defaults; used only to seed a first-run user config with the repos
// that exist on this machine (the packaged app ships none).
const defaultsPath = rootPath("crux.config.json");
// Per-user workspaces live outside the app so every teammate has their own.
export const userConfigPath = process.env.CRUX_CONFIG ?? path.join(CRUX_HOME, "config.json");

// One-time move from the app's old name: ~/.qualitylab → ~/.crux. Per item,
// because the desktop shell may already have created ~/.crux for its log.
(function migrateFromQualityLab() {
  const oldDir = path.join(os.homedir(), ".qualitylab");
  const newDir = path.join(os.homedir(), ".crux");
  if (process.env.CRUX_CONFIG || CRUX_HOME !== DEFAULT_HOME || !fs.existsSync(oldDir)) return;
  fs.mkdirSync(newDir, { recursive: true });
  for (const name of fs.readdirSync(oldDir)) {
    const target = path.join(newDir, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.renameSync(path.join(oldDir, name), target);
    } catch {
      /* leave it; the user can move it by hand */
    }
  }
  try {
    if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
  } catch {
    /* not empty or already gone */
  }
})();

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function loadConfig(): CruxConfig {
  const user = readJson(userConfigPath);
  if (user?.repos) {
    return { agent: { permissionMode: "bypassPermissions" }, preview: { port: 8321 }, ...user };
  }
  // `npm run app:fresh`: start empty, exactly like a brand-new user.
  const fresh = !!process.env.CRUX_FRESH;
  // A dev copy (separate CRUX_HOME) starts with the installed app's workspaces.
  const installed = !fresh && CRUX_HOME !== DEFAULT_HOME ? readJson(path.join(DEFAULT_HOME, "config.json")) : null;
  if (installed?.repos) {
    const copy = { agent: { permissionMode: "bypassPermissions" }, preview: { port: 8321 }, ...installed };
    saveConfig(copy);
    return copy;
  }
  const defaults = fresh ? {} : readJson(defaultsPath) ?? {};
  const seeded: CruxConfig = {
    repos: Object.fromEntries(
      Object.entries((defaults.repos ?? {}) as Record<string, RepoConfig>).filter(([, r]) => fs.existsSync(r.path)),
    ),
    agent: defaults.agent ?? { permissionMode: "bypassPermissions" },
    preview: defaults.preview ?? { port: 8321 },
  };
  saveConfig(seeded);
  return seeded;
}

export function saveConfig(next: CruxConfig = config): void {
  fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
  fs.writeFileSync(userConfigPath, JSON.stringify(next, null, 2) + "\n");
}

// Mutated in place by the workspace routes so every module sees updates.
export const config = loadConfig();

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Guess what a folder is from the marker files at its root. */
export function detectKind(dir: string): RepoKind {
  const has = (name: string) => fs.existsSync(path.join(dir, name));
  if (has("mkdocs.yml") || has("mkdocs.yaml")) return "mkdocs";
  if (has("manage.py")) return "backend";
  if (["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"].some(has)) return "playwright";
  if (["next.config.js", "next.config.mjs", "next.config.ts"].some(has) || (has("nx.json") && has("apps"))) return "frontend";
  if (has("pytest.ini") || has("conftest.py")) return "pytest";
  for (const file of ["pyproject.toml", "setup.cfg", "tox.ini"]) {
    try {
      if (/pytest/.test(fs.readFileSync(path.join(dir, file), "utf8"))) return "pytest";
    } catch {
      /* missing */
    }
  }
  return "generic";
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "ws";
}

export function addWorkspace(input: { path: string; label?: string; kind?: RepoKind }): [string, RepoConfig] {
  const abs = path.resolve(expandHome(input.path.trim()));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Not a folder: ${abs}`);
  if (Object.values(config.repos).some((r) => r.path === abs)) throw new Error("That folder is already a workspace");
  const label = input.label?.trim() || path.basename(abs);
  const kind = input.kind ?? detectKind(abs);
  let key = slug(label);
  for (let n = 2; config.repos[key]; n++) key = `${slug(label)}-${n}`;
  config.repos[key] = { label, path: abs, kind };
  saveConfig();
  return [key, config.repos[key]];
}

export function updateWorkspace(
  key: string,
  patch: { label?: string; kind?: RepoKind; pinned?: boolean; color?: string | null },
): RepoConfig {
  const repo = config.repos[key];
  if (!repo) throw new Error("Unknown workspace");
  if (patch.label?.trim()) repo.label = patch.label.trim();
  if (patch.kind) repo.kind = patch.kind;
  if (typeof patch.pinned === "boolean") repo.pinned = patch.pinned;
  if (patch.color === null || patch.color === "") delete repo.color;
  else if (typeof patch.color === "string" && /^#[0-9a-f]{6}$/i.test(patch.color)) repo.color = patch.color;
  saveConfig();
  return repo;
}

export function removeWorkspace(key: string): void {
  delete config.repos[key];
  saveConfig();
}
