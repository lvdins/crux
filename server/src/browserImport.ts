import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Import logins (cookies) from Arc, Chrome and other Chromium browsers into
 * Crux's browser (macOS). Chromium keeps cookies in an SQLite file, their
 * values encrypted with a key from the login keychain ("<Browser> Safe
 * Storage"): reading that key shows macOS's keychain prompt. Only the sites
 * you pick are decrypted, and the cookies go straight to the Crux window,
 * which hands them to its browser (browser_import_cookies in browser.rs).
 */

interface Browser {
  id: string;
  name: string;
  /** Chromium "User Data" folder. */
  dir: string;
  /** Keychain item holding the cookie key. */
  keychain: string;
}

const SUPPORT = path.join(os.homedir(), "Library", "Application Support");
const BROWSERS: Browser[] = [
  { id: "arc", name: "Arc", dir: path.join(SUPPORT, "Arc", "User Data"), keychain: "Arc Safe Storage" },
  { id: "chrome", name: "Chrome", dir: path.join(SUPPORT, "Google", "Chrome"), keychain: "Chrome Safe Storage" },
  { id: "brave", name: "Brave", dir: path.join(SUPPORT, "BraveSoftware", "Brave-Browser"), keychain: "Brave Safe Storage" },
  { id: "edge", name: "Edge", dir: path.join(SUPPORT, "Microsoft Edge"), keychain: "Microsoft Edge Safe Storage" },
  { id: "chromium", name: "Chromium", dir: path.join(SUPPORT, "Chromium"), keychain: "Chromium Safe Storage" },
];

export interface ImportSource {
  browser: string;
  name: string;
  profile: string;
  profileName: string;
}

const cookieFile = (b: Browser, profile: string) => {
  for (const rel of [["Cookies"], ["Network", "Cookies"]]) {
    const f = path.join(b.dir, profile, ...rel);
    try {
      fs.accessSync(f, fs.constants.R_OK);
      return f;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        throw new Error(`macOS blocked reading ${b.name}'s data. Allow Crux in System Settings → Privacy & Security → App Management (or "Files and Folders"), then try again.`);
      }
    }
  }
  return null;
};

/** Every installed Chromium browser profile that has cookies. */
export function importSources(): ImportSource[] {
  if (process.platform !== "darwin") return [];
  const out: ImportSource[] = [];
  for (const b of BROWSERS) {
    if (!fs.existsSync(b.dir)) continue;
    let names: Record<string, { name?: string }> = {};
    try {
      names = JSON.parse(fs.readFileSync(path.join(b.dir, "Local State"), "utf8")).profile?.info_cache ?? {};
    } catch {
      /* no Local State: folder names only */
    }
    let profiles: string[];
    try {
      profiles = fs.readdirSync(b.dir).filter((d) => (d === "Default" || /^Profile \d+$/.test(d)) && cookieFile(b, d));
    } catch {
      // macOS keeps other apps' data private until you allow it ("access data
      // from other apps"): offer it anyway, reading it asks / explains.
      profiles = ["Default"];
    }
    for (const p of profiles) {
      // Arc keeps an internal profile ("__ARC_SYSTEM_PROFILE") with no logins of yours.
      if (names[p]?.name?.startsWith("__")) continue;
      out.push({ browser: b.id, name: b.name, profile: p, profileName: names[p]?.name || p });
    }
  }
  return out;
}

/** Read the cookie table from a copy (the browser may be running and holds the file). */
async function readCookies(b: Browser, profile: string) {
  const file = cookieFile(b, profile);
  if (!/^(Default|Profile \d+)$/.test(profile) || !file) throw new Error("Profile not found");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crux-cookies-"));
  try {
    for (const ext of ["", "-wal", "-journal"]) {
      if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, path.join(tmp, "Cookies" + ext));
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(tmp, "Cookies"), { readOnly: true });
    try {
      const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined)?.value ?? 0);
      const rows = db
        .prepare("SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite FROM cookies")
        .all() as unknown as CookieRow[];
      return { version, rows };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: string;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

/** "mail.google.com" / ".google.com" → "google.com" (two-letter-ish second levels like co.uk keep three). */
export function siteOf(host: string): string {
  const parts = host.replace(/^\./, "").toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  const n = parts.length;
  const short = parts[n - 1].length === 2 && parts[n - 2].length <= 3;
  return parts.slice(short ? -3 : -2).join(".");
}

/** Sites with cookies in a profile, most cookies first (nothing decrypted). */
export async function importSites(browser: string, profile: string) {
  const b = BROWSERS.find((x) => x.id === browser);
  if (!b) throw new Error("Unknown browser");
  const { rows } = await readCookies(b, profile);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(siteOf(r.host_key), (counts.get(siteOf(r.host_key)) ?? 0) + 1);
  return [...counts].map(([site, cookies]) => ({ site, cookies })).sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site));
}

/** The browser's cookie key, from the keychain (macOS asks you to allow it). */
function keychainPassword(service: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", ["find-generic-password", "-w", "-s", service], { timeout: 120_000 }, (err, out) => {
      if (err) reject(new Error(`Couldn't read "${service}" from the keychain (not allowed, or not found).`));
      else resolve(out.trim());
    });
  });
}

/** Chromium on macOS: AES-128-CBC, key = PBKDF2-SHA1(password, "saltysalt", 1003), IV = 16 spaces. */
export function decryptValue(enc: Uint8Array, key: Buffer, dbVersion: number): string | null {
  const buf = Buffer.from(enc);
  if (buf.length === 0) return null;
  if (buf.subarray(0, 3).toString() !== "v10") return null;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    // Since cookie DB version 24, values start with SHA-256 of the host.
    if (dbVersion >= 24) plain = plain.subarray(32);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

export const deriveKey = (password: string) => crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");

/** Set-Cookie lines for the picked sites, ready for the Crux browser. */
export async function importCookies(browser: string, profile: string, sites: string[]) {
  const b = BROWSERS.find((x) => x.id === browser);
  if (!b) throw new Error("Unknown browser");
  const wanted = new Set(sites.map((s) => s.toLowerCase()));
  const { version, rows } = await readCookies(b, profile);
  const picked = rows.filter((r) => wanted.has(siteOf(r.host_key)));
  const needsKey = picked.some((r) => !r.value && r.encrypted_value?.length);
  const key = needsKey ? deriveKey(await keychainPassword(b.keychain)) : Buffer.alloc(16);
  const lines: string[] = [];
  let skipped = 0;
  const nowSec = Date.now() / 1000;
  for (const r of picked) {
    const value = r.value || decryptValue(r.encrypted_value, key, version);
    // Unreadable, or not valid in a Set-Cookie line.
    if (value == null || /[;\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || !/^[!#-'*+\-.0-9A-Z^-z|~_]+$/i.test(r.name)) {
      skipped++;
      continue;
    }
    // Chromium time: microseconds since 1601. 0 = session cookie: keep it 30 days.
    const micros = Number(r.expires_utc);
    const expires = micros > 0 ? micros / 1e6 - 11_644_473_600 : nowSec + 30 * 86_400;
    if (expires <= nowSec) continue;
    // ".google.com" (all subdomains) vs "mail.google.com" (that host only).
    // Crux's cookie parser drops one leading dot, so domain-wide ones get two.
    const domain = r.host_key.startsWith(".") ? `.${r.host_key}` : r.host_key;
    const parts = [`${r.name}=${value}`, `Domain=${domain}`, `Path=${r.path || "/"}`, `Expires=${new Date(expires * 1000).toUTCString()}`];
    if (r.is_secure) parts.push("Secure");
    if (r.is_httponly) parts.push("HttpOnly");
    const same = { 0: "None", 1: "Lax", 2: "Strict" }[r.samesite as 0 | 1 | 2];
    if (same && (same !== "None" || r.is_secure)) parts.push(`SameSite=${same}`);
    lines.push(parts.join("; "));
  }
  return { cookies: lines, skipped, sites: new Set(picked.map((r) => siteOf(r.host_key))).size };
}
