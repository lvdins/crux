import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RepoKind = "mkdocs" | "playwright" | "pytest" | "frontend" | "backend" | "generic";

export interface RepoConfig {
  label: string;
  path: string;
  kind: RepoKind;
  pinned?: boolean;
}

export interface QualityLabConfig {
  repos: Record<string, RepoConfig>;
  agent: { permissionMode: "acceptEdits" | "default" | "bypassPermissions" };
  preview: { port: number };
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Bundled defaults (the original Giraffe360 setup); used only to seed a
// first-run user config with the repos that exist on this machine.
const defaultsPath = path.resolve(here, "../../qualitylab.config.json");
// Per-user workspaces live outside the app so every teammate has their own.
export const userConfigPath = process.env.QUALITYLAB_CONFIG ?? path.join(os.homedir(), ".qualitylab", "config.json");

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function loadConfig(): QualityLabConfig {
  const user = readJson(userConfigPath);
  if (user?.repos) {
    return { agent: { permissionMode: "bypassPermissions" }, preview: { port: 8321 }, ...user };
  }
  const defaults = readJson(defaultsPath) ?? {};
  const seeded: QualityLabConfig = {
    repos: Object.fromEntries(
      Object.entries((defaults.repos ?? {}) as Record<string, RepoConfig>).filter(([, r]) => fs.existsSync(r.path)),
    ),
    agent: defaults.agent ?? { permissionMode: "bypassPermissions" },
    preview: defaults.preview ?? { port: 8321 },
  };
  saveConfig(seeded);
  return seeded;
}

export function saveConfig(next: QualityLabConfig = config): void {
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

export function updateWorkspace(key: string, patch: { label?: string; kind?: RepoKind; pinned?: boolean }): RepoConfig {
  const repo = config.repos[key];
  if (!repo) throw new Error("Unknown workspace");
  if (patch.label?.trim()) repo.label = patch.label.trim();
  if (patch.kind) repo.kind = patch.kind;
  if (typeof patch.pinned === "boolean") repo.pinned = patch.pinned;
  saveConfig();
  return repo;
}

export function removeWorkspace(key: string): void {
  delete config.repos[key];
  saveConfig();
}
