import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRUX_HOME, DEFAULT_HOME } from "./paths.js";

/**
 * Appearance (Settings → Appearance) and shareable theme files.
 * Server-side mirror of client/src/appearance.ts: the server imports nothing
 * from the client, so the shape is declared loosely here and every value is
 * checked before it is saved.
 */
export type Appearance = Record<string, unknown>;
export interface ThemeFile {
  crux: "theme";
  version: 1;
  name: string;
  appearance: Appearance;
  scheme?: Record<string, string>;
}

export const THEMES_DIR = path.join(CRUX_HOME, "themes");
export const ASSETS_DIR = path.join(THEMES_DIR, "assets");
/** tauri.conf.json (and tauri.dev.json) let the webview read these folders directly. */
export const ASSET_PROTOCOL_OK = [DEFAULT_HOME, path.join(os.homedir(), ".crux-dev")].includes(CRUX_HOME);
export const MAX_ASSET = 20 * 1024 * 1024;

const THEMES = ["crux-dark", "crux-light", "system", "cyberpunk", "unicorn"];
const KINDS = ["claude", "codex", "shell"];
const CURSORS = ["block", "bar", "underline"];
const FITS = ["cover", "contain", "tile", "center"];
const WILD = ["neon-sunset", "glitch-overdrive", "matrix-rainbow", "hologram-unicorn", "night-market", "laser-grid", "pink-dream", "neon-pink"];
const EVERY = [1, 5, 15, 60, "session"];
const SCHEME_COLORS = [
  "foreground", "background", "cursor", "selectionBackground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];
export const ASSET_EXT: Record<string, string> = {
  gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm",
};

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v);
const oneOf = <T>(list: readonly T[], v: unknown): v is T => list.includes(v as T);
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
const id = (v: unknown): v is string => typeof v === "string" && /^[\w:. -]{1,80}$/.test(v);

/** A plain file name: no folders, no "..", an allowed media extension. */
export function assetNameOk(v: unknown): v is string {
  return (
    typeof v === "string" && v.length <= 120 && !v.includes("/") && !v.includes("\\") && !v.includes("..") &&
    /^[\w][\w .-]*$/.test(v) && path.extname(v).slice(1).toLowerCase() in ASSET_EXT
  );
}

/** Drop undefined values so saved JSON stays tidy. */
function tidy<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function cleanFont(v: unknown) {
  if (!obj(v)) return undefined;
  return tidy({
    family: typeof v.family === "string" && v.family.trim() ? v.family.replace(/[;{}<>\\]/g, "").trim().slice(0, 200) : undefined,
    size: num(v.size, 10, 24),
    lineHeight: num(v.lineHeight, 1, 2),
    ligatures: typeof v.ligatures === "boolean" ? v.ligatures : undefined,
    cursorStyle: oneOf(CURSORS, v.cursorStyle) ? v.cursorStyle : undefined,
    cursorBlink: typeof v.cursorBlink === "boolean" ? v.cursorBlink : undefined,
  });
}

function cleanBackground(v: unknown) {
  if (!obj(v)) return undefined;
  switch (v.kind) {
    case "none":
      return { kind: "none" };
    case "solid":
      return hex(v.color) ? { kind: "solid", color: v.color } : undefined;
    case "gradient":
      return hex(v.from) && hex(v.to) ? { kind: "gradient", from: v.from, to: v.to, angle: num(v.angle, 0, 360) ?? 135 } : undefined;
    case "image":
    case "gif":
    case "video":
      return assetNameOk(v.asset) ? { kind: v.kind, asset: v.asset } : undefined;
    case "wild":
      return oneOf(WILD, v.id) ? { kind: "wild", id: v.id } : undefined;
    default:
      return undefined;
  }
}

function cleanBgStyle(v: unknown) {
  if (!obj(v)) return undefined;
  return {
    fit: oneOf(FITS, v.fit) ? v.fit : "cover",
    opacity: num(v.opacity, 0, 100) ?? 100,
    blur: num(v.blur, 0, 20) ?? 0,
    dim: num(v.dim, 0, 90) ?? 0,
  };
}

function cleanLook(v: unknown) {
  if (!obj(v)) return undefined;
  return tidy({
    scheme: id(v.scheme) ? v.scheme : undefined,
    background: cleanBackground(v.background),
    backgroundStyle: cleanBgStyle(v.backgroundStyle),
  });
}

export function cleanScheme(v: unknown): Record<string, string> | undefined {
  if (!obj(v) || typeof v.name !== "string" || !v.name.trim()) return undefined;
  const out: Record<string, string> = { name: v.name.trim().slice(0, 60) };
  for (const k of SCHEME_COLORS) {
    if (!hex(v[k])) return undefined;
    out[k] = v[k] as string;
  }
  return out;
}

function cleanRecord<T>(v: unknown, keyOk: (k: string) => boolean, clean: (x: unknown) => T | undefined, max = 200) {
  if (!obj(v)) return undefined;
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v).slice(0, max)) {
    const c = keyOk(k) ? clean(x) : undefined;
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/**
 * Keep only known keys with valid values. Missing / invalid keys are left
 * out; the client fills them from DEFAULT_APPEARANCE (withDefaults).
 */
export function cleanAppearance(v: unknown): Appearance | undefined {
  if (!obj(v)) return undefined;
  const p = v.playlist;
  return tidy({
    theme: oneOf(THEMES, v.theme) ? v.theme : undefined,
    accent: hex(v.accent) ? v.accent : undefined,
    terminalScheme: id(v.terminalScheme) ? v.terminalScheme : undefined,
    font: cleanFont(v.font),
    background: cleanBackground(v.background),
    backgroundStyle: cleanBgStyle(v.backgroundStyle),
    playlist: obj(p)
      ? {
          ids: Array.isArray(p.ids) ? [...new Set(p.ids.filter((x) => oneOf(WILD, x)))] : [],
          every: oneOf(EVERY, p.every) ? p.every : 15,
          order: p.order === "in-order" ? "in-order" : "shuffle",
        }
      : undefined,
    reactToState: typeof v.reactToState === "boolean" ? v.reactToState : undefined,
    reduceMotion: typeof v.reduceMotion === "boolean" ? v.reduceMotion : undefined,
    perWorkspace: cleanRecord(v.perWorkspace, (k) => /^[\w.-]{1,64}$/.test(k), cleanLook),
    perKind: cleanRecord(v.perKind, (k) => KINDS.includes(k), cleanLook),
    customSchemes: cleanRecord(v.customSchemes, (k) => k.length > 0 && k.length <= 60, cleanScheme, 50),
  });
}

/** Theme file names: lower-case words and dashes. */
export function safeName(name: unknown): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

export function cleanTheme(v: unknown): ThemeFile | null {
  if (!obj(v) || typeof v.name !== "string" || !safeName(v.name)) return null;
  const appearance = cleanAppearance(v.appearance) ?? {};
  // A theme file is the look, not your per-workspace setup.
  delete appearance.perWorkspace;
  delete appearance.perKind;
  delete appearance.customSchemes;
  const scheme = cleanScheme(v.scheme);
  return tidy({ crux: "theme", version: 1, name: v.name.trim().slice(0, 60), appearance, scheme }) as ThemeFile;
}

const themePath = (name: string) => path.join(THEMES_DIR, `${safeName(name)}.json`);

export function listThemes(): (ThemeFile & { file: string })[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(THEMES_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: (ThemeFile & { file: string })[] = [];
  for (const n of names.sort()) {
    try {
      const t = cleanTheme(JSON.parse(fs.readFileSync(path.join(THEMES_DIR, n), "utf8")));
      if (t) out.push({ ...t, file: n.slice(0, -5) });
    } catch {
      /* not a theme */
    }
  }
  return out;
}

export function readTheme(name: string): ThemeFile | null {
  try {
    return cleanTheme(JSON.parse(fs.readFileSync(themePath(name), "utf8")));
  } catch {
    return null;
  }
}

export function saveTheme(input: unknown): ThemeFile & { file: string } {
  const t = cleanTheme(input);
  if (!t) throw new Error("Not a theme (needs a name)");
  fs.mkdirSync(THEMES_DIR, { recursive: true });
  fs.writeFileSync(themePath(t.name), JSON.stringify(t, null, 2) + "\n");
  return { ...t, file: safeName(t.name) };
}

export function deleteTheme(name: string): boolean {
  const file = themePath(name);
  if (!safeName(name) || !fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/**
 * Store an uploaded background. The name keeps the original (made safe) plus
 * a short content hash, so two different files never overwrite each other.
 */
export function saveAsset(rawName: string, data: Buffer): string {
  const ext = path.extname(rawName).slice(1).toLowerCase();
  if (!(ext in ASSET_EXT)) throw new Error("Only gif, png, jpeg, webp, mp4 and webm files");
  if (data.length > MAX_ASSET) throw new Error("Files up to 20 MB");
  if (!data.length) throw new Error("Empty file");
  const base = path.basename(rawName, path.extname(rawName)).replace(/[^\w-]+/g, "-").replace(/^[-_]+|-+$/g, "").slice(0, 60) || "background";
  const hash = crypto.createHash("sha1").update(data).digest("hex").slice(0, 8);
  const name = base.endsWith(`-${hash}`) ? `${base}.${ext}` : `${base}-${hash}.${ext}`;
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, name), data);
  return name;
}

export function assetPath(name: string): string | null {
  if (!assetNameOk(name)) return null;
  const file = path.join(ASSETS_DIR, name);
  return fs.existsSync(file) ? file : null;
}

/** One self-contained file: the theme plus its background, base64-embedded. */
export function exportTheme(name: string): (ThemeFile & { assets?: Record<string, string> }) | null {
  const t = readTheme(name);
  if (!t) return null;
  const bg = t.appearance.background as { asset?: string } | undefined;
  const file = bg?.asset ? assetPath(bg.asset) : null;
  return file ? { ...t, assets: { [bg!.asset!]: fs.readFileSync(file).toString("base64") } } : t;
}

/** Accepts an exported file (or a plain theme file). Never fetches anything. */
export function importTheme(input: unknown): ThemeFile & { file: string } {
  if (!obj(input)) throw new Error("Not a theme file");
  const t = cleanTheme(input);
  if (!t) throw new Error("Not a theme file (needs a name)");
  const bg = t.appearance.background as { kind: string; asset?: string } | undefined;
  if (bg?.asset) {
    const data = obj(input.assets) ? input.assets[bg.asset] : undefined;
    if (typeof data === "string") {
      bg.asset = saveAsset(bg.asset, Buffer.from(data, "base64"));
    } else if (!assetPath(bg.asset)) {
      // The background isn't in the file and isn't here: keep the rest of the look.
      delete t.appearance.background;
    }
  }
  return saveTheme(t);
}
