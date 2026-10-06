import pty, { type IPty } from "node-pty";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import { agentEnv, writeMcpConfig } from "./agent-setup.js";

/**
 * PTYs are keyed by client-chosen terminal id (a workspace can hold several
 * tabs); the repo only determines the shell's cwd. Sessions are shared across
 * clients and survive workspace switches and page reloads.
 */

interface Entry {
  pty: IPty;
  buffer: string;
  subs: Set<WebSocket>;
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
    const shell = process.env.SHELL || "/bin/zsh";
    // Strip Claude-session markers: if the QualityLab server itself was started
    // from a Claude Code session, child shells would otherwise be treated as
    // nested sessions (transcript saving off, etc.).
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^CLAUDE/i.test(key)),
    ) as Record<string, string>;
    // Boot tabs run the command as part of the shell invocation — typing it
    // into an interactive shell races fancy prompt init (p10k discards
    // typed-ahead input). `-il -c` sources zshrc (PATH), runs the command
    // once init is done, then execs a normal interactive shell.
    const safeBoot = bootCmd && /^[\w ./-]+$/.test(bootCmd) ? bootCmd : undefined;
    const args = safeBoot ? ["-il", "-c", `${safeBoot}; exec ${shell} -il`] : ["-l"];
    writeMcpConfig(repo); // workspace may have been added since startup
    const proc = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: cols || 100,
      rows: rows || 30,
      cwd: repoCfg.path,
      env: { ...env, ...agentEnv(repo, shell), TERM: "xterm-256color" },
    });
    const e: Entry = { pty: proc, buffer: "", subs: new Set() };
    proc.onData((data) => {
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

export function termInput(id: string, data: string): void {
  terms.get(id)?.pty.write(data);
}

export function termResize(id: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) terms.get(id)?.pty.resize(cols, rows);
}

export function killTerm(id: string): void {
  terms.get(id)?.pty.kill();
  terms.delete(id);
}

export function detachAll(ws: WebSocket): void {
  for (const entry of terms.values()) entry.subs.delete(ws);
}

export function killAllTerms(): void {
  for (const entry of terms.values()) entry.pty.kill();
  terms.clear();
}
