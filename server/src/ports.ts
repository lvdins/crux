/**
 * Ports opened from Crux terminals: a listener is shown when its process
 * descends from one of our pty shells. The parsers are pure (tested in
 * __tests__/ports.test.ts); scanning and stopping live below them.
 */

export interface Listener {
  pid: number;
  port: number;
}
export interface Proc {
  pid: number;
  ppid: number;
  command: string;
  /** Windows only: start time, to reject a parent pid that was reused. */
  created?: number;
}
export interface PortInfo {
  port: number;
  pid: number;
  command: string;
  termId: string;
  ws: string;
  /** The listener is the pty shell itself: stopping it ends the terminal. */
  isShell: boolean;
  title?: string;
}

const portOf = (addr: string) => Number(addr.slice(addr.lastIndexOf(":") + 1)) || 0;

/** `lsof -nP -iTCP -sTCP:LISTEN -F pn`: `p<pid>`, then `f<fd>` / `n<addr>` per fd. */
export function parseLsof(out: string): Listener[] {
  const res: Listener[] = [];
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) {
      const port = portOf(line.slice(1));
      if (port) res.push({ pid, port });
    }
  }
  return res;
}

/** `ss -ltnpH`: local address is column 4; one line can name several pids. */
export function parseSs(out: string): Listener[] {
  const res: Listener[] = [];
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const port = cols[3] ? portOf(cols[3]) : 0;
    if (!port) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) res.push({ pid: Number(m[1]), port });
  }
  return res;
}

/** `netstat -ano`: the state column is localized, so a listener is a row whose foreign address is unset. */
export function parseNetstat(out: string): Listener[] {
  const res: Listener[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || (cols[2] !== "0.0.0.0:0" && cols[2] !== "[::]:0")) continue;
    const port = portOf(cols[1]);
    const pid = Number(cols[cols.length - 1]);
    if (port && pid) res.push({ pid, port });
  }
  return res;
}

/** `ps -A -o pid=,ppid=,comm=`: macOS prints comm as a full path. */
export function parsePs(out: string): Proc[] {
  const res: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (m) res.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].split("/").pop() || m[3] });
  }
  return res;
}

/** Windows: `pid,ppid,created,name` lines (see WIN_PROCS). */
export function parseWinProcs(out: string): Proc[] {
  const res: Proc[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(\d+),(\d+),(\d+),(.+)$/);
    if (m) res.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Number(m[3]), command: m[4].trim() });
  }
  return res;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

export function parseTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const title = m[1].replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ENTITIES[e]).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 80) : undefined;
}

/** Only plain localhost pages: the URL ends up on a command line (`cmd /c start`). */
export function isLocalUrl(url: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}\/[\w\-./~%]*$/.test(url);
}

/** Each listener whose parent chain reaches a pty pid; one row per port, sorted. */
export function matchPorts(listeners: Listener[], procs: Proc[], roots: Map<number, { termId: string; ws: string }>): PortInfo[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const rows = new Map<number, PortInfo>();
  for (const l of listeners) {
    if (rows.has(l.port)) continue;
    let pid = l.pid;
    const seen = new Set<number>();
    while (pid > 1 && !roots.has(pid) && !seen.has(pid)) {
      seen.add(pid);
      const p = byPid.get(pid);
      if (!p) break;
      const parent = byPid.get(p.ppid);
      if (p.created !== undefined && parent?.created !== undefined && parent.created > p.created) break;
      pid = p.ppid;
    }
    const root = roots.get(pid);
    if (!root) continue;
    rows.set(l.port, { port: l.port, pid: l.pid, command: byPid.get(l.pid)?.command ?? "?", termId: root.termId, ws: root.ws, isShell: roots.has(l.pid) });
  }
  return [...rows.values()].sort((a, b) => a.port - b.port);
}
