import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pty, { type IPty } from "node-pty";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import { agentEnv, writeMcpConfig } from "./agent-setup.js";
import { findCodexSession, forgetTerm, loadTerm, pruneTerms, saveTerm } from "./sessions.js";

/**
 * PTYs are keyed by client-chosen terminal id (a workspace can hold several
 * tabs); the repo only determines the shell's cwd. Sessions are shared across
 * clients and survive workspace switches and page reloads.
 */

interface Entry {
  pty: IPty;
  buffer: string;
  subs: Set<WebSocket>;
  cwd: string;
  startedAt: number;
  /** Started as `codex …`: its conversation id is looked up for reopening. */
  codex: boolean;
  codexSession?: string;
  /** Output since the last save. */
  dirty: boolean;
}

const terms = new Map<string, Entry>();
const MAX_BUFFER = 400_000;

/** Debug ring buffer of recent attach calls (served at /api/debug/opens). */
export const openLog: { at: string; id: string; repo: string; fresh: boolean; bootCmd?: string; existed: boolean }[] = [];

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

export function attachTerm(
  id: string,
  repo: string,
  ws: WebSocket,
  cols: number,
  rows: number,
  fresh: boolean,
  bootCmd?: string,
): void {
  const repoCfg = config.repos[repo];
  if (!id || !repoCfg) return;
  openLog.push({ at: new Date().toISOString(), id, repo, fresh, bootCmd, existed: terms.has(id) });
  if (openLog.length > 50) openLog.shift();
  let entry = terms.get(id);
  if (!entry) {
    // macOS defaults to zsh, Linux to bash.
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    // Strip Claude-session markers: if the Crux server itself was started
    // from a Claude Code session, child shells would otherwise be treated as
    // nested sessions (transcript saving off, etc.).
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^CLAUDE/i.test(key)),
    ) as Record<string, string>;
    // Boot tabs run the command as part of the shell invocation — typing it
    // into an interactive shell races fancy prompt init (p10k discards
    // typed-ahead input). `-il -c` sources zshrc (PATH), runs the command
    // once init is done, then execs a normal interactive shell.
    const saved = loadTerm(id);
    let safeBoot = bootCmd && /^[\w ./@-]+$/.test(bootCmd) ? resumeIfSaved(bootCmd) : undefined;
    // Reopened after Crux quit: Codex picks its conversation back up.
    if (safeBoot === "codex" && saved?.codexSession && /^[0-9a-f-]{36}$/i.test(saved.codexSession)) safeBoot = `codex resume ${saved.codexSession}`;
    const resumes = !!safeBoot && /^(claude --resume|codex resume) /.test(safeBoot);
    const args = safeBoot ? ["-il", "-c", `${safeBoot}; exec ${shell} -il`] : ["-l"];
    writeMcpConfig(repo); // workspace may have been added since startup
    const proc = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: cols || 100,
      rows: rows || 30,
      cwd: repoCfg.path,
      env: { ...env, ...agentEnv(repo, shell, id), TERM: "xterm-256color" },
    });
    // A resumed conversation redraws itself; anything else shows its last screen.
    const restored = saved?.output && !resumes ? `${saved.output}\x1b[?1049l\x1b[0m\r\n\x1b[2m── reopened · output above is from before Crux quit ──\x1b[0m\r\n` : "";
    const e: Entry = {
      pty: proc,
      buffer: restored,
      subs: new Set(),
      cwd: repoCfg.path,
      startedAt: Date.now(),
      codex: !!safeBoot?.startsWith("codex"),
      codexSession: safeBoot?.startsWith("codex resume ") ? saved?.codexSession : undefined,
      dirty: !!restored,
    };
    proc.onData((data) => {
      e.dirty = true;
      e.buffer = (e.buffer + data).slice(-MAX_BUFFER);
      for (const sub of e.subs) send(sub, { type: "term:data", id, data });
    });
    proc.onExit(({ exitCode }) => {
      for (const sub of e.subs) send(sub, { type: "term:exit", id, code: exitCode });
      terms.delete(id);
    });
    terms.set(id, e);
    entry = e;
  } else if (cols && rows) {
    entry.pty.resize(cols, rows);
  }
  entry.subs.add(ws);
  if (fresh && entry.buffer) {
    send(ws, { type: "term:data", id, data: entry.buffer });
  }
}

/**
 * Claude chats start as `claude --session-id <uuid>`. When that conversation
 * already exists (Crux restarted), reopen it with `--resume` instead.
 */
function resumeIfSaved(cmd: string): string {
  const m = /^claude --session-id ([0-9a-f-]{36})$/.exec(cmd);
  if (!m) return cmd;
  const projects = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const dir of fs.readdirSync(projects)) {
      if (fs.existsSync(path.join(projects, dir, `${m[1]}.jsonl`))) return `claude --resume ${m[1]}`;
    }
  } catch {
    /* no ~/.claude yet */
  }
  return cmd;
}

/** Foreground program of a terminal (e.g. "zsh", "claude", "codex"). */
export function termProcess(id: string): string | null {
  const entry = terms.get(id);
  return entry ? entry.pty.process : null;
}

export function termInput(id: string, data: string): void {
  terms.get(id)?.pty.write(data);
}

export function termResize(id: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) terms.get(id)?.pty.resize(cols, rows);
}

/** Closed by the user: nothing to reopen. */
export function killTerm(id: string): void {
  terms.get(id)?.pty.kill();
  terms.delete(id);
  forgetTerm(id);
}

/** Saves each terminal's screen (and Codex conversation) for reopening. */
export function saveTerms(all = false): void {
  const taken = new Set([...terms.values()].map((e) => e.codexSession).filter(Boolean) as string[]);
  for (const [id, e] of terms) {
    if (e.codex && !e.codexSession) {
      e.codexSession = findCodexSession(e.cwd, e.startedAt, taken);
      if (e.codexSession) {
        taken.add(e.codexSession);
        e.dirty = true;
      }
    }
    if (!e.dirty && !all) continue;
    e.dirty = false;
    try {
      saveTerm(id, { output: e.buffer, codexSession: e.codexSession });
    } catch {
      /* disk full etc.: try again next time */
    }
  }
}
pruneTerms();
setInterval(() => saveTerms(), 10_000).unref();

export function detachAll(ws: WebSocket): void {
  for (const entry of terms.values()) entry.subs.delete(ws);
}

/** Crux is quitting: save, then stop (the tabs reopen next time). */
export function killAllTerms(): void {
  saveTerms(true);
  for (const entry of terms.values()) entry.pty.kill();
  terms.clear();
}
