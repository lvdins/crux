import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRUX_HOME } from "./paths.js";

/**
 * Chats reopen where they were after Crux quits:
 * - each terminal's recent output is saved, and shown again when that tab
 *   is reopened (terminals, or agents without a conversation to resume);
 * - Claude conversations resume through `--resume` (see term.ts);
 * - Codex conversations resume through `codex resume <id>`; which rollout
 *   belongs to which tab is matched by folder and start time.
 * Also: past Claude / Codex conversations per workspace, for chat search.
 */

const DIR = path.join(CRUX_HOME, "terms");
const MAX_SAVED = 200_000;
const fileOf = (id: string) => path.join(DIR, `${id.replace(/[^\w.-]+/g, "_")}.json`);

export interface SavedTerm {
  output: string;
  /** Codex conversation running in this tab, when found. */
  codexSession?: string;
}

export function loadTerm(id: string): SavedTerm | null {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), "utf8")) as SavedTerm;
  } catch {
    return null;
  }
}

let dirReady = false;

/** Saved screens of tabs that never came back (e.g. dropped chats): gone after 14 days. */
export function pruneTerms(days = 14): void {
  const cutoff = Date.now() - days * 86400_000;
  try {
    for (const f of fs.readdirSync(DIR)) {
      const file = path.join(DIR, f);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch {
    /* no saved screens yet */
  }
}
export function saveTerm(id: string, t: SavedTerm): void {
  // Terminal output can hold tokens: readable by you only.
  if (!dirReady) {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(DIR, 0o700);
    dirReady = true;
  }
  fs.writeFileSync(fileOf(id), JSON.stringify({ ...t, output: t.output.slice(-MAX_SAVED) }), { mode: 0o600 });
}

export function forgetTerm(id: string): void {
  fs.rmSync(fileOf(id), { force: true });
}

// ---------- Codex ----------

const CODEX_DIR = path.join(os.homedir(), ".codex", "sessions");

interface Rollout {
  id: string;
  file: string;
  cwd: string;
  startedAt: number;
  mtime: number;
}

/** Codex rollouts from the last `days` days (newest first), main threads only. */
function codexRollouts(days = 45): Rollout[] {
  const out: Rollout[] = [];
  const since = Date.now() - days * 86400_000;
  for (let d = 0; d <= days; d++) {
    const day = new Date(Date.now() - d * 86400_000);
    const dir = path.join(
      CODEX_DIR,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const meta = firstLine(file);
      const p = meta?.payload;
      if (!p?.id || !p.cwd || p.parent_thread_id) continue;
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime < since) continue;
      out.push({ id: p.id, file, cwd: p.cwd, startedAt: Date.parse(p.timestamp ?? meta.timestamp) || mtime, mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The 45-day rollout list, shared for 15 s: history asks for it once per
 *  workspace, and search once per keystroke. */
let rolloutCache: { at: number; list: Rollout[] } | null = null;
function recentRollouts(): Rollout[] {
  if (!rolloutCache || Date.now() - rolloutCache.at > 15_000) rolloutCache = { at: Date.now(), list: codexRollouts() };
  return rolloutCache.list;
}

function firstLine(file: string): any {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return JSON.parse(buf.subarray(0, n).toString("utf8").split("\n")[0]);
  } catch {
    return null;
  }
}

/** The Codex conversation a tab started at `startedAt` in `cwd` is running (not one another tab has). */
export function findCodexSession(cwd: string, startedAt: number, taken: Set<string>): string | undefined {
  return codexRollouts(2)
    .filter((r) => r.cwd === cwd && r.startedAt >= startedAt - 5000 && !taken.has(r.id))
    .sort((a, b) => a.startedAt - b.startedAt)[0]?.id;
}

// ---------- History (chat search) ----------

export interface PastChat {
  kind: "claude" | "codex";
  id: string;
  title: string;
  /** First thing you asked. */
  prompt: string;
  at: string;
  /** Text around the search match. */
  match?: string;
  /** Git branch the chat ran on (Claude records it). */
  branch?: string;
}

/** A transcript reduced to what listing and search need. */
interface Parsed {
  chat: PastChat | null;
  /** Message texts in order (searched with `around`). */
  texts: string[];
}

/** Parsed transcripts by file and modification time: listing and searching
 *  re-read only files that changed (search used to re-read every transcript
 *  on each keystroke). */
const parseCache = new Map<string, { mtime: number; parsed: Parsed }>();
function parsedOf(file: string, mtime: number, parse: () => Parsed): Parsed {
  const hit = parseCache.get(file);
  if (hit && hit.mtime === mtime) return hit.parsed;
  const parsed = parse();
  parseCache.set(file, { mtime, parsed });
  return parsed;
}

/** The chat, with `match` set to the first hit of `q` (lowercased), or null when nothing matches. */
function search(p: Parsed, q: string): PastChat | null {
  if (!p.chat || !q) return p.chat;
  let match: string | undefined;
  for (const text of p.texts) if ((match = around(text, q))) break;
  if (!match && p.chat.kind === "claude") match = around(p.chat.title, q);
  return match ? { ...p.chat, match } : null;
}

const claudeDir = (cwd: string) => path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join(" ")
      : "";

const around = (text: string, q: string) => {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return undefined;
  const s = Math.max(0, i - 50);
  return (s ? "…" : "") + text.slice(s, i + q.length + 80).replace(/\s+/g, " ").trim();
};

function parseClaude(file: string): Parsed {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { chat: null, texts: [] };
  }
  let title = "";
  let prompt = "";
  let branch = "";
  const texts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof j.gitBranch === "string" && j.gitBranch) branch = j.gitBranch;
    if (j.type === "custom-title" && j.customTitle) title = j.customTitle;
    else if (j.type === "ai-title" && j.aiTitle && !title) title = j.aiTitle;
    else if ((j.type === "user" || j.type === "assistant") && !j.isSidechain && !j.isMeta) {
      const text = textOf(j.message?.content);
      if (j.type === "user" && !prompt && text && !text.startsWith("<")) prompt = text.slice(0, 200);
      if (text) texts.push(text);
    }
  }
  if (!prompt && !title) return { chat: null, texts: [] };
  return {
    chat: {
      kind: "claude",
      id: path.basename(file, ".jsonl"),
      title: title || prompt.slice(0, 60),
      prompt,
      at: new Date(fs.statSync(file).mtimeMs).toISOString(),
      branch: branch || undefined,
    },
    texts,
  };
}

function parseCodex(r: Rollout): Parsed {
  let raw: string;
  try {
    raw = fs.readFileSync(r.file, "utf8");
  } catch {
    return { chat: null, texts: [] };
  }
  let prompt = "";
  const texts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"message"')) continue;
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const p = j.payload;
    if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
    const text = Array.isArray(p.content) ? p.content.map((c: any) => c?.text ?? "").join(" ") : "";
    if (p.role === "user" && !prompt && text && !text.startsWith("<")) prompt = text.slice(0, 200);
    if (text) texts.push(text);
  }
  if (!prompt) return { chat: null, texts: [] };
  return { chat: { kind: "codex", id: r.id, title: prompt.slice(0, 60), prompt, at: new Date(r.mtime).toISOString() }, texts };
}

/** Past conversations started in a folder, newest first; `q` searches their text. */
export function pastChats(cwd: string, q = "", limit = 40): PastChat[] {
  const query = q.trim().toLowerCase();
  const out: PastChat[] = [];
  const dir = claudeDir(cwd);
  let files: { file: string; mtime: number }[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => ({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 150);
  } catch {
    /* never used Claude here */
  }
  for (const f of files) {
    const c = search(parsedOf(f.file, f.mtime, () => parseClaude(f.file)), query);
    if (c) out.push(c);
    if (out.length >= limit) break;
  }
  for (const r of recentRollouts().filter((r) => r.cwd === cwd).slice(0, 80)) {
    const c = search(parsedOf(r.file, r.mtime, () => parseCodex(r)), query);
    if (c) out.push(c);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
