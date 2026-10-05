import pty, { type IPty } from "node-pty";
import type { WebSocket } from "ws";
import { config } from "./config.js";

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
  let entry = terms.get(id);
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
      for (const sub of e.subs) send(sub, { type: "term:data", id, data });
    });
    proc.onExit(({ exitCode }) => {
      for (const sub of e.subs) send(sub, { type: "term:exit", id, code: exitCode });
      terms.delete(id);
    });
    terms.set(id, e);
    entry = e;
    if (bootCmd && /^[\w ./-]+$/.test(bootCmd)) {
      // Fancy prompts (p10k etc.) discard input typed during their async
      // init, so type the command only once the shell has produced output
      // and then gone quiet — like a human would.
      let lastData = 0;
      const seen = proc.onData(() => {
        lastData = Date.now();
      });
      const started = Date.now();
      const timer = setInterval(() => {
        const quiet = lastData > 0 && Date.now() - lastData > 300;
        const timedOut = Date.now() - started > 4000;
        if (quiet || timedOut) {
          clearInterval(timer);
          seen.dispose();
          if (terms.has(id)) proc.write(`${bootCmd}\n`);
        }
      }, 100);
    }
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
