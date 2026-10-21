import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qaRoot } from "./config.js";
import { CRUX_HOME } from "./paths.js";
import { getSecret } from "./secrets.js";

/**
 * Lab account switcher: named fixtures (CRUX_HOME/fixtures.json, no secrets)
 * whose `mint` script turns Keychain credentials into a session. Activating
 * one for a workspace takes the qa skill's account lock
 * ($QA_ROOT/.locks/<ACCOUNT>, an atomic mkdir), mints, writes the round's
 * Playwright persona file, and hands the env to that workspace's new
 * terminals; a timer re-mints 5 minutes before the session expires.
 *
 * The UI logs the in-app browser in with the minted cookies
 * (browser_import_cookies). All browser tabs share one WebKit cookie jar, so
 * a per-fixture data store is not done here.
 */

export interface Fixture {
  id: string;
  label: string;
  /** What briefs and published text call this account, e.g. "<CS_ADMIN>". */
  placeholder: string;
  /** Env var for the mint script → Keychain secret name (crux.<name>). */
  env: Record<string, string>;
  /** Sites the session is for: minted cookies outside them aren't imported. */
  hosts: string[];
  /** Team script, run without a shell; prints {cookies, storageState, env, expiresAt}. */
  mint: { command: string };
  /** Lock name under $QA_ROOT/.locks (default: id). */
  account?: string;
  /** Persona file name under <round>/pw/auth (default: id). */
  persona?: string;
}

export interface Minted {
  cookies: string[];
  storageState: unknown;
  env: Record<string, string>;
  /** Epoch ms; null when the script didn't say. */
  expiresAt: number | null;
}

interface Owner {
  pid: number;
  ws: string;
  round: string | null;
  at: string;
  token?: string;
}

interface Active {
  id: string;
  ws: string;
  round: string | null;
  /** Where the mint script runs (the workspace folder). */
  cwd: string;
  lock: string;
  token: string;
  minted: Minted;
  mintedAt: number;
  persona: string | null;
  timer?: ReturnType<typeof setTimeout>;
}

export const FIXTURES_FILE = path.join(CRUX_HOME, "fixtures.json");
const ENV_DIR = path.join(CRUX_HOME, "accounts");
const ID = /^[\w.-]{1,40}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Re-mint this long before the session expires. */
export const REFRESH_BEFORE = 5 * 60_000;
const MIN_DELAY = 15_000;
const RETRY = 60_000;
const MAX_TIMER = 2 ** 31 - 1;

export { qaRoot };

/** Active fixture per workspace. */
const active = new Map<string, Active>();
let broadcast: (msg: unknown) => void = () => {};
export const setAccountBroadcast = (fn: (msg: unknown) => void) => {
  broadcast = fn;
};

// ---------- fixtures.json ----------

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function cleanFixture(raw: any): Fixture {
  const id = str(raw?.id, 40);
  if (!ID.test(id)) throw new Error(`Fixture id "${id}": letters, digits, '.', '_' or '-'`);
  const command = str(raw?.mint?.command, 1000);
  if (!command) throw new Error(`Fixture "${id}": mint.command is required`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw?.env && typeof raw.env === "object" ? raw.env : {})) {
    if (!ENV_NAME.test(k) || typeof v !== "string" || !/^[\w.-]{1,64}$/.test(v)) throw new Error(`Fixture "${id}": env maps VAR → secret name`);
    env[k] = v;
  }
  const f: Fixture = {
    id,
    label: str(raw?.label, 80) || id,
    placeholder: str(raw?.placeholder, 80) || `<${id.toUpperCase()}>`,
    env,
    hosts: (Array.isArray(raw?.hosts) ? raw.hosts : []).map((h: unknown) => str(h, 200).toLowerCase()).filter(Boolean),
    mint: { command },
  };
  const account = str(raw?.account, 40);
  const persona = str(raw?.persona, 40);
  if (account) {
    if (!ID.test(account)) throw new Error(`Fixture "${id}": bad account name`);
    f.account = account;
  }
  if (persona) {
    if (!ID.test(persona)) throw new Error(`Fixture "${id}": bad persona name`);
    f.persona = persona;
  }
  return f;
}

export function loadFixtures(): Fixture[] {
  try {
    const list = JSON.parse(fs.readFileSync(FIXTURES_FILE, "utf8"));
    if (!Array.isArray(list)) return [];
    return list.flatMap((f) => {
      try {
        return [cleanFixture(f)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function saveFixtures(raw: unknown): Fixture[] {
  if (!Array.isArray(raw)) throw new Error("Expected a list of fixtures");
  const list = raw.map(cleanFixture);
  const ids = new Set<string>();
  for (const f of list) {
    if (ids.has(f.id)) throw new Error(`Fixture id "${f.id}" is used twice`);
    ids.add(f.id);
  }
  writePrivate(FIXTURES_FILE, JSON.stringify(list, null, 2) + "\n");
  return list;
}

/** Temp file + rename, mode 0600 (also when the file existed). */
function writePrivate(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// ---------- locks ----------

const lockPath = (f: Fixture) => path.join(qaRoot(), ".locks", f.account ?? f.id);

function readOwner(dir: string): Owner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type LockState =
  | { state: "free" }
  | { state: "held"; mine: boolean; ws: string | null; round: string | null; at: string | null; pid: number | null; stale: boolean; by: string };

function describe(owner: Owner | null, mine: boolean): string {
  if (!owner) return "another run (no owner.json)";
  if (mine) return `this Crux (workspace ${owner.ws})`;
  const where = [owner.ws && `workspace ${owner.ws}`, owner.round && `round ${owner.round}`].filter(Boolean).join(", ");
  return `Crux pid ${owner.pid}${where ? ` (${where})` : ""}${alive(owner.pid) ? "" : ", not running"}`;
}

export function lockState(f: Fixture): LockState {
  const dir = lockPath(f);
  if (!fs.existsSync(dir)) return { state: "free" };
  const owner = readOwner(dir);
  const mine = [...active.values()].some((a) => a.lock === dir && owner?.token === a.token);
  return {
    state: "held",
    mine,
    ws: owner?.ws ?? null,
    round: owner?.round ?? null,
    at: owner?.at ?? null,
    pid: owner?.pid ?? null,
    stale: !!owner && !mine && !alive(owner.pid),
    by: describe(owner, mine),
  };
}

/** mkdir is atomic: whoever creates the folder holds the account. */
function takeLock(f: Fixture, ws: string, round: string | null): { dir: string; token: string } {
  const dir = lockPath(f);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const s = lockState(f);
    throw Object.assign(new Error(`${f.label} is locked by ${s.state === "held" ? s.by : "another run"}`), { status: 409, lock: s });
  }
  const token = crypto.randomUUID();
  const owner: Owner = { pid: process.pid, ws, round, at: new Date().toISOString(), token };
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner, null, 2) + "\n");
  return { dir, token };
}

/** Removes the lock only when it's still the one this process made. */
function releaseLock(dir: string, token: string): boolean {
  const owner = readOwner(dir);
  if (!owner || owner.pid !== process.pid || owner.token !== token) return false;
  fs.rmSync(path.join(dir, "owner.json"), { force: true });
  try {
    fs.rmdirSync(dir);
  } catch {
    /* someone put files in it: leave it */
    return false;
  }
  return true;
}

// ---------- mint ----------

const COOKIE_NAME = /^[!#-'*+\-.0-9A-Z^-z|~_]+$/i;
const BAD_VALUE = /[;\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** A Playwright cookie object (or a ready Set-Cookie line) → Set-Cookie line for browser_import_cookies. */
export function toSetCookie(c: unknown): string | null {
  if (typeof c === "string") return c.trim() && !/[\r\n]/.test(c) ? c.trim() : null;
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const name = String(o.name ?? "");
  const value = String(o.value ?? "");
  const domain = String(o.domain ?? "");
  if (!COOKIE_NAME.test(name) || BAD_VALUE.test(value) || !domain) return null;
  // Crux's cookie parser drops one leading dot, so domain-wide ones get two (as browserImport.ts).
  const parts = [`${name}=${value}`, `Domain=${domain.startsWith(".") ? `.${domain}` : domain}`, `Path=${String(o.path || "/")}`];
  const expires = Number(o.expires);
  if (Number.isFinite(expires) && expires > 0) parts.push(`Expires=${new Date(expires * 1000).toUTCString()}`);
  if (o.secure) parts.push("Secure");
  if (o.httpOnly) parts.push("HttpOnly");
  if (o.sameSite === "Strict" || o.sameSite === "Lax" || (o.sameSite === "None" && o.secure)) parts.push(`SameSite=${o.sameSite}`);
  return parts.join("; ");
}

const cookieHost = (line: string) => /;\s*Domain=\.*([^;]+)/i.exec(line)?.[1]?.trim().toLowerCase() ?? "";
const forHosts = (line: string, hosts: string[]) => {
  if (!hosts.length) return true;
  const d = cookieHost(line);
  return !d || hosts.some((h) => d === h || h.endsWith(`.${d}`) || d.endsWith(`.${h}`));
};

export function normaliseExpiry(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return normaliseExpiry(n);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** The mint script's stdout: one JSON object (log lines before it are ignored). */
export function parseMint(stdout: string, hosts: string[] = []): Minted {
  let data: any = null;
  try {
    data = JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    try {
      data = start >= 0 ? JSON.parse(stdout.slice(start)) : null;
    } catch {
      data = null;
    }
  }
  if (!data || typeof data !== "object") throw new Error("The mint script didn't print JSON {cookies, storageState, env, expiresAt}");
  const state = data.storageState && typeof data.storageState === "object" ? data.storageState : null;
  const rawCookies: unknown[] = Array.isArray(data.cookies) ? data.cookies : Array.isArray(state?.cookies) ? state.cookies : [];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.env && typeof data.env === "object" ? data.env : {})) {
    if (ENV_NAME.test(k) && (typeof v === "string" || typeof v === "number")) env[k] = String(v);
  }
  return {
    cookies: rawCookies.map(toSetCookie).filter((l): l is string => !!l && forHosts(l, hosts)),
    storageState: state,
    env,
    expiresAt: normaliseExpiry(data.expiresAt),
  };
}

function splitCommand(command: string, cwd: string): [string, string[]] {
  const [bin, ...args] = command.trim().split(/\s+/);
  const home = bin.startsWith("~/") ? path.join(os.homedir(), bin.slice(2)) : bin;
  return [home.includes("/") ? path.resolve(cwd, home) : home, args];
}

async function runMint(f: Fixture, cwd: string): Promise<Minted> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CRUX_FIXTURE: f.id, CRUX_ACCOUNT: f.placeholder };
  for (const [name, secret] of Object.entries(f.env)) {
    const value = await getSecret(secret);
    if (value == null) throw new Error(`Secret "${secret}" (for ${name}) isn't set: Settings → Lab accounts`);
    env[name] = value;
  }
  const [bin, args] = splitCommand(f.mint.command, cwd);
  const out = await new Promise<string>((resolve, reject) => {
    execFile(bin, args, { cwd, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      // Last stderr line only, short: the script's message, not its output.
      const why = String(stderr).trim().split("\n").pop()?.slice(0, 200);
      reject(new Error(`Mint for ${f.label} failed${why ? `: ${why}` : ` (${(err as { code?: unknown }).code ?? err.message})`}`));
    });
  });
  return parseMint(out, f.hosts);
}

// ---------- rounds, persona, env file ----------

/** A round folder under $QA_ROOT (absolute, or relative to it). */
export function resolveRound(round: string): string {
  const root = qaRoot();
  const dir = path.resolve(root, round);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error(`The round must be inside ${root}`);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`No round folder at ${dir}`);
  return dir;
}

function writePersona(a: Active, f: Fixture): string | null {
  if (!a.round || !a.minted.storageState) return null;
  const file = path.join(a.round, "pw", "auth", `${f.persona ?? f.id}.json`);
  writePrivate(file, JSON.stringify(a.minted.storageState, null, 2) + "\n");
  return file;
}

const envFile = (ws: string) => path.join(ENV_DIR, `${ws.replace(/[^\w.-]/g, "_")}.env`);
const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** What a workspace's agents get: the minted env plus the placeholder (never credentials). */
function agentVars(a: Active, f: Fixture): Record<string, string> {
  return {
    ...a.minted.env,
    CRUX_ACCOUNT: f.placeholder,
    CRUX_ACCOUNT_FIXTURE: f.id,
    CRUX_ACCOUNT_EXPIRES: a.minted.expiresAt ? new Date(a.minted.expiresAt).toISOString() : "",
    CRUX_ACCOUNT_ENV: envFile(a.ws),
    ...(a.persona ? { CRUX_PERSONA_FILE: a.persona } : {}),
  };
}

/** Running agents keep their start env: `source "$CRUX_ACCOUNT_ENV"` picks up a refreshed session. */
function writeEnvFile(a: Active, f: Fixture) {
  const vars = agentVars(a, f);
  writePrivate(envFile(a.ws), Object.entries(vars).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join("\n") + "\n");
}

// ---------- refresh ----------

/** ms until the re-mint: 5 min before expiry, never sooner than 15 s, never past setTimeout's limit. */
export function refreshDelay(expiresAt: number | null, now = Date.now()): number | null {
  if (expiresAt == null) return null;
  return Math.min(MAX_TIMER, Math.max(MIN_DELAY, expiresAt - REFRESH_BEFORE - now));
}

function schedule(a: Active, delay: number | null) {
  clearTimeout(a.timer);
  a.timer = undefined;
  if (delay == null) return;
  a.timer = setTimeout(() => void refresh(a), delay);
  a.timer.unref?.();
}

async function refresh(a: Active) {
  if (active.get(a.ws) !== a) return;
  const f = loadFixtures().find((x) => x.id === a.id);
  if (!f) return;
  try {
    const minted = await runMint(f, a.cwd);
    if (active.get(a.ws) !== a) return;
    a.minted = minted;
    a.mintedAt = Date.now();
    a.persona = writePersona(a, f) ?? a.persona;
    writeEnvFile(a, f);
    schedule(a, refreshDelay(minted.expiresAt));
    broadcast({ type: "account:refreshed", ws: a.ws, id: a.id, expiresAt: minted.expiresAt });
  } catch (err) {
    const expired = a.minted.expiresAt != null && Date.now() >= a.minted.expiresAt;
    broadcast({ type: "account:error", ws: a.ws, id: a.id, error: (err as Error).message, expired });
    if (!expired) schedule(a, RETRY);
  }
}

// ---------- activate / release ----------

export interface ActiveInfo {
  ws: string;
  id: string;
  round: string | null;
  expiresAt: number | null;
  mintedAt: number;
  refreshAt: number | null;
  persona: string | null;
}

const info = (a: Active): ActiveInfo => {
  const d = refreshDelay(a.minted.expiresAt, a.mintedAt);
  return { ws: a.ws, id: a.id, round: a.round, expiresAt: a.minted.expiresAt, mintedAt: a.mintedAt, refreshAt: d == null ? null : a.mintedAt + d, persona: a.persona };
};

export function listFixtures() {
  return {
    qaRoot: qaRoot(),
    fixtures: loadFixtures().map((f) => ({ ...f, lock: lockState(f) })),
    active: [...active.values()].map(info),
  };
}

/**
 * Activate a fixture for a workspace: lock, mint, persona file, env. The
 * workspace's previous fixture is released only once the new one works.
 * `cwd` is where the mint script runs (the workspace folder).
 */
export async function activate(id: string, opts: { ws: string; round?: string | null; cwd: string }): Promise<ActiveInfo & { cookies: string[] }> {
  const f = loadFixtures().find((x) => x.id === id);
  if (!f) throw Object.assign(new Error(`Unknown fixture "${id}"`), { status: 404 });
  const round = opts.round ? resolveRound(opts.round) : null;
  const elsewhere = [...active.values()].find((a) => a.id === id && a.ws !== opts.ws);
  if (elsewhere) throw Object.assign(new Error(`${f.label} is active in workspace ${elsewhere.ws}: release it there first`), { status: 409 });
  const prev = active.get(opts.ws);
  const same = prev?.id === id ? prev : undefined;
  const lock = same ? { dir: same.lock, token: same.token } : takeLock(f, opts.ws, round);
  let minted: Minted;
  try {
    minted = await runMint(f, opts.cwd);
  } catch (err) {
    if (!same) releaseLock(lock.dir, lock.token);
    throw err;
  }
  if (prev && !same) {
    clearTimeout(prev.timer);
    releaseLock(prev.lock, prev.token);
  }
  if (same) clearTimeout(same.timer);
  const a: Active = { id, ws: opts.ws, round, cwd: opts.cwd, lock: lock.dir, token: lock.token, minted, mintedAt: Date.now(), persona: null };
  a.persona = writePersona(a, f);
  writeEnvFile(a, f);
  active.set(opts.ws, a);
  schedule(a, refreshDelay(minted.expiresAt));
  broadcast({ type: "account:changed", ws: opts.ws, id });
  return { ...info(a), cookies: minted.cookies };
}

/** Release a fixture wherever this Crux has it active. False: it wasn't. */
export function release(id: string): boolean {
  const a = [...active.values()].find((x) => x.id === id);
  if (!a) return false;
  clearTimeout(a.timer);
  active.delete(a.ws);
  releaseLock(a.lock, a.token);
  fs.rmSync(envFile(a.ws), { force: true });
  broadcast({ type: "account:changed", ws: a.ws, id: null });
  return true;
}

/** On quit: give back every lock this process took. */
export function releaseAll() {
  for (const a of [...active.values()]) release(a.id);
}

/** The latest minted cookies of a workspace's fixture (the UI re-imports them after a refresh). */
export const activeCookies = (ws: string) => active.get(ws)?.minted.cookies ?? null;

/** Env for a new terminal of this workspace (see agentEnv). */
export function accountEnv(ws: string): Record<string, string> {
  const a = active.get(ws);
  const f = a && loadFixtures().find((x) => x.id === a.id);
  return a && f ? agentVars(a, f) : {};
}
