import pty, { type IPty } from "node-pty";
import type { WebSocket } from "ws";
import { config } from "./config.js";

/**
 * One persistent PTY per workspace (repo), shared by every connected client.
 * The shell starts in the repo's directory — the user runs `claude`, `codex`,
 * or anything else themselves, and the session survives workspace switches
 * and page reloads.
 */

interface Entry {
  pty: IPty;
  buffer: string;
  subs: Set<WebSocket>;
}

const terms = new Map<string, Entry>();
const MAX_BUFFER = 400_000;

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

export function attachTerm(repo: string, ws: WebSocket, cols: number, rows: number, fresh: boolean): void {
  const repoCfg = config.repos[repo];
  if (!repoCfg) return;
  let entry = terms.get(repo);
  if (!entry) {
    const shell = process.env.SHELL || "/bin/zsh";
    // Strip Claude-session markers: if the SuperQA server itself was started
    // from a Claude Code session, child shells would otherwise be treated as
    // nested sessions (transcript saving off, etc.).
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^CLAUDE/i.test(key)),
    ) as Record<string, string>;
    const proc = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: cols || 100,
      rows: rows || 30,
      cwd: repoCfg.path,
      env: { ...env, TERM: "xterm-256color" },
    });
    const e: Entry = { pty: proc, buffer: "", subs: new Set() };
    proc.onData((data) => {
      e.buffer = (e.buffer + data).slice(-MAX_BUFFER);
      for (const sub of e.subs) send(sub, { type: "term:data", repo, data });
    });
    proc.onExit(({ exitCode }) => {
      for (const sub of e.subs) send(sub, { type: "term:exit", repo, code: exitCode });
      terms.delete(repo);
    });
    terms.set(repo, e);
    entry = e;
  } else if (cols && rows) {
    entry.pty.resize(cols, rows);
  }
  entry.subs.add(ws);
  if (fresh && entry.buffer) {
    send(ws, { type: "term:data", repo, data: entry.buffer });
  }
}

export function termInput(repo: string, data: string): void {
  terms.get(repo)?.pty.write(data);
}

export function termResize(repo: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) terms.get(repo)?.pty.resize(cols, rows);
}

export function detachAll(ws: WebSocket): void {
  for (const entry of terms.values()) entry.subs.delete(ws);
}

export function killAllTerms(): void {
  for (const entry of terms.values()) entry.pty.kill();
  terms.clear();
}
