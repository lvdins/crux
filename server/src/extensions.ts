import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { getSecret } from "./secrets.js";
import { CRUX_HOME } from "./paths.js";

/**
 * Local extensions: folders in CRUX_HOME/extensions that exist only on the
 * machine that made them. Nothing ships with Crux; a folder may hold
 *   server.mjs  `export async function activate(ctx)` — its own API routes
 *               under /api/ext/<name>/; may return `{ stop() }`
 *   client.mjs  `export function activate(crux)` — runs in the main window;
 *               may return a cleanup function
 * plus any files client.mjs loads (served from /ext/<name>@<version>/).
 * Editing its code (.mjs/.js/.css/.html/.svg) or config.json reloads that
 * extension in the UI (onExtensionsChanged); the server part restarts only
 * when server.mjs, a file under server/, or config.json changed.
 */

export const EXT_DIR = path.join(CRUX_HOME, "extensions");
const NAME = /^[a-z0-9][\w-]{0,31}$/i;

export interface ExtensionInfo {
  name: string;
  client: boolean;
  /** Changes on every reload; part of the files' URL so the UI never gets a cached copy. */
  version: number;
}

export interface ExtensionContext {
  name: string;
  dir: string;
  /** Mounted at /api/ext/<name>. */
  router: express.Router;
  /** Keychain item `crux.<name>` (see secrets.ts). */
  getSecret: (name: string) => Promise<string | null>;
  log: (...args: unknown[]) => void;
}

interface Loaded {
  info: ExtensionInfo;
  files: express.Handler;
  router: express.Router | null;
  stop?: () => void;
}

const loaded = new Map<string, Loaded>();
let notify: () => void = () => {};

export function listExtensions(): ExtensionInfo[] {
  return [...loaded.values()].map((l) => l.info).sort((a, b) => a.name.localeCompare(b.name));
}

/** Called after an extension (re)loads or goes away, so the UI can reload its part. */
export function onExtensionsChanged(fn: () => void) {
  notify = fn;
}

function names(): string[] {
  try {
    return fs.readdirSync(EXT_DIR).filter((n) => NAME.test(n) && fs.statSync(path.join(EXT_DIR, n)).isDirectory());
  } catch {
    return [];
  }
}

function unload(name: string) {
  const old = loaded.get(name);
  if (!old) return;
  try {
    old.stop?.();
  } catch (err) {
    console.log(`[ext:${name}] stop failed:`, err);
  }
  loaded.delete(name);
}

async function load(name: string) {
  unload(name);
  const dir = path.join(EXT_DIR, name);
  if (!fs.existsSync(dir)) return;
  const log = (...args: unknown[]) => console.log(`[ext:${name}]`, ...args);
  const version = Date.now();
  const entry: Loaded = {
    info: { name, client: fs.existsSync(path.join(dir, "client.mjs")), version },
    files: express.static(dir, { index: false, dotfiles: "deny" }),
    router: null,
  };
  const server = path.join(dir, "server.mjs");
  if (fs.existsSync(server)) {
    try {
      // A fresh URL per load: Node caches modules by URL.
      const mod = await import(`${pathToFileURL(server).href}?v=${version}`);
      const router = express.Router();
      const handle = await mod.activate?.({ name, dir, router, getSecret, log } satisfies ExtensionContext);
      entry.router = router;
      entry.stop = typeof handle?.stop === "function" ? handle.stop : undefined;
    } catch (err) {
      log("failed to load server.mjs:", err);
      return;
    }
  }
  loaded.set(name, entry);
  log("loaded");
}

/** Serves every extension (current version, whatever it is) and reloads one when its folder changes. */
export async function installExtensions(app: express.Express): Promise<void> {
  // Mounted once; each request goes to the extension's current files / router.
  app.use("/ext/:spec", (req, res, next) => {
    const ext = loaded.get(req.params.spec.split("@")[0]);
    if (!ext) return next();
    // Versioned files may be cached for good; a reload changes the URL.
    if (req.params.spec.includes("@")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    ext.files(req, res, next);
  });
  app.use("/api/ext/:name", (req, res, next) => {
    const router = loaded.get(req.params.name)?.router;
    return router ? router(req, res, next) : next();
  });

  for (const name of names()) await load(name);

  // Coalesce an editor's burst of writes into one reload per extension.
  const pending = new Map<string, { timer: NodeJS.Timeout; server: boolean }>();
  const reload = (name: string, server: boolean) => {
    const prev = pending.get(name);
    clearTimeout(prev?.timer);
    const entry = {
      server: server || !!prev?.server,
      timer: setTimeout(async () => {
        pending.delete(name);
        const ext = loaded.get(name);
        // UI-only change: keep the running server part (and its state), just give the files a new version.
        if (ext && !entry.server && fs.existsSync(path.join(EXT_DIR, name))) ext.info = { ...ext.info, client: fs.existsSync(path.join(EXT_DIR, name, "client.mjs")), version: Date.now() };
        else await load(name);
        notify();
      }, 300),
    };
    pending.set(name, entry);
  };
  try {
    fs.mkdirSync(EXT_DIR, { recursive: true });
    fs.watch(EXT_DIR, { recursive: true }, (_event, file) => {
      const name = String(file ?? "").split(path.sep)[0];
      // Code and config only: data files the extension writes while running must not reload it.
      const rel = String(file).slice(name.length + 1);
      if (!NAME.test(name) || !/(\.(m?js|css|html|svg)|(^|[\\/])config\.json)$/.test(rel)) return;
      reload(name, /^(server\.mjs|config\.json|server[\\/].*)$/.test(rel) || !loaded.has(name));
    });
  } catch (err) {
    console.log("extensions: no live reload:", err);
  }
}
