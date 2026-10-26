# Sidebar Ports Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A collapsible "Ports" section above the sidebar footer listing TCP ports opened by processes started from Crux terminals, with open / copy / stop actions.

**Architecture:** `server/src/ports.ts` holds pure parsers (lsof / ss / netstat / ps / Windows process list) plus `matchPorts`, which walks each listener's parent chain up to a Crux pty pid. A cached `getPorts()` runs the platform commands on demand; Express routes expose list / stop / open-external. The client `PortsPanel` polls every 3 s and renders above `.side-footer`.

**Tech Stack:** Node 20 + Express + node-pty (server, TypeScript run by tsx), React (client), tests with `node:assert` run via `npx tsx`.

Spec: `docs/superpowers/specs/2026-10-26-sidebar-ports-design.md`

**Working tree note:** `main` has unrelated uncommitted edits (App.tsx, styles.css, SettingsModal.tsx, …). Every commit stages **only the listed files**. Task 7 edits App.tsx and styles.css, which also hold the user's uncommitted work: before Task 7 the user commits or stashes those edits (ask; don't do it for them).

---

## Chunk 1: Pure parsing + matching (TDD)

### Task 1: Parsers

**Files:**
- Create: `server/src/ports.ts`
- Test: `server/src/__tests__/ports.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/__tests__/ports.test.ts`:

```ts
// Run: npx tsx server/src/__tests__/ports.test.ts
import assert from "node:assert/strict";
import { isLocalUrl, matchPorts, parseLsof, parseNetstat, parsePs, parseSs, parseTitle, parseWinProcs } from "../ports.js";

/* ---------- lsof -F pn: p line, then f/n pairs per fd ---------- */
assert.deepEqual(
  parseLsof("p1262\nf40\nn127.0.0.1:9277\nf41\nn[::1]:9277\np88\nf12\nn*:5173\n"),
  [
    { pid: 1262, port: 9277 },
    { pid: 1262, port: 9277 },
    { pid: 88, port: 5173 },
  ],
);
assert.deepEqual(parseLsof(""), []);

/* ---------- ss -ltnpH: several pids on one line ---------- */
assert.deepEqual(
  parseSs(
    'LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=4321,fd=20))\n' +
      'LISTEN 0      4096            [::]:3000         [::]:*    users:(("node",pid=10,fd=3),("node",pid=11,fd=3))\n' +
      "LISTEN 0      128          0.0.0.0:22        0.0.0.0:*\n",
  ),
  [
    { pid: 4321, port: 5173 },
    { pid: 10, port: 3000 },
    { pid: 11, port: 3000 },
  ],
);

/* ---------- netstat -ano: listener = foreign 0.0.0.0:0 / [::]:0, state localized ---------- */
assert.deepEqual(
  parseNetstat(
    "\r\nAktive Verbindungen\r\n\r\n  Proto  Lokale Adresse  Remoteadresse  Status  PID\r\n" +
      "  TCP    0.0.0.0:5173   0.0.0.0:0   ABHÖREN   1234\r\n" +
      "  TCP    127.0.0.1:5173   127.0.0.1:50000   HERGESTELLT   1234\r\n" +
      "  TCP    [::1]:8080   [::]:0   ABHÖREN   99\r\n",
  ),
  [
    { pid: 1234, port: 5173 },
    { pid: 99, port: 8080 },
  ],
);

/* ---------- ps: basename of full-path comm, names with spaces ---------- */
assert.deepEqual(
  parsePs("    1     0 /sbin/launchd\n  500     1 /opt/homebrew/Cellar/node@24/24.1.0/bin/node\n  501   500 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n  502   501 vite\n"),
  [
    { pid: 1, ppid: 0, command: "launchd" },
    { pid: 500, ppid: 1, command: "node" },
    { pid: 501, ppid: 500, command: "Google Chrome" },
    { pid: 502, ppid: 501, command: "vite" },
  ],
);

/* ---------- Windows process list: pid,ppid,created,name ---------- */
assert.deepEqual(parseWinProcs("4,0,0,System\r\n800,4,133000000000000000,node.exe\r\n"), [
  { pid: 4, ppid: 0, created: 0, command: "System" },
  { pid: 800, ppid: 4, created: 133000000000000000, command: "node.exe" },
]);

/* ---------- page title ---------- */
assert.equal(parseTitle("<html><head><title>\n  Crux &amp; Dev </title></head>"), "Crux & Dev");
assert.equal(parseTitle("<html>no title</html>"), undefined);

/* ---------- localhost-only URL guard ---------- */
assert.equal(isLocalUrl("http://localhost:5173/"), true);
assert.equal(isLocalUrl("http://127.0.0.1:3000/"), true);
assert.equal(isLocalUrl("http://[::1]:8080/"), true);
assert.equal(isLocalUrl("http://localhost.evil.com:80/"), false);
assert.equal(isLocalUrl("https://example.com/"), false);
assert.equal(isLocalUrl("file:///etc/passwd"), false);
assert.equal(isLocalUrl("http://localhost:5173/?a=1&calc"), false);

console.log("ports parsers ok");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx server/src/__tests__/ports.test.ts`
Expected: FAIL, `Cannot find module '../ports.js'`

- [ ] **Step 3: Write the parsers**

`server/src/ports.ts`:

```ts
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

export function matchPorts(_listeners: Listener[], _procs: Proc[], _roots: Map<number, { termId: string; ws: string }>): PortInfo[] {
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx server/src/__tests__/ports.test.ts`
Expected: `ports parsers ok`

- [ ] **Step 5: Commit**

```bash
git add server/src/ports.ts server/src/__tests__/ports.test.ts
git commit -m "feat(ports): parse lsof, ss, netstat and process lists"
```

### Task 2: `matchPorts`

**Files:**
- Modify: `server/src/ports.ts` (replace the `matchPorts` stub)
- Test: `server/src/__tests__/ports.test.ts`

- [ ] **Step 1: Write the failing test** — append before the final `console.log`:

```ts
/* ---------- matching listeners to Crux terminals ---------- */
const roots = new Map([[100, { termId: "t1", ws: "crux" }]]);
const procs = [
  { pid: 100, ppid: 1, command: "zsh" },
  { pid: 200, ppid: 100, command: "node" }, // child of the shell
  { pid: 300, ppid: 200, command: "vite" }, // grandchild
  { pid: 400, ppid: 1, command: "postgres" }, // not ours
];
assert.deepEqual(
  matchPorts(
    [
      { pid: 300, port: 5173 },
      { pid: 300, port: 5173 }, // IPv6 duplicate
      { pid: 200, port: 3000 },
      { pid: 400, port: 5432 },
      { pid: 100, port: 8000 }, // the shell itself (exec python -m http.server)
    ],
    procs,
    roots,
  ),
  [
    { port: 3000, pid: 200, command: "node", termId: "t1", ws: "crux", isShell: false },
    { port: 5173, pid: 300, command: "vite", termId: "t1", ws: "crux", isShell: false },
    { port: 8000, pid: 100, command: "zsh", termId: "t1", ws: "crux", isShell: true },
  ],
);
// ppid cycle terminates
assert.deepEqual(matchPorts([{ pid: 7, port: 1 }], [{ pid: 7, ppid: 8, command: "a" }, { pid: 8, ppid: 7, command: "b" }], roots), []);
// Windows: parent pid reused by a newer process doesn't count
assert.deepEqual(
  matchPorts(
    [{ pid: 900, port: 4000 }],
    [
      { pid: 100, ppid: 1, command: "pwsh.exe", created: 50 }, // started after its "child": pid reuse
      { pid: 900, ppid: 100, command: "node.exe", created: 10 },
    ],
    roots,
  ),
  [],
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx server/src/__tests__/ports.test.ts`
Expected: FAIL, `AssertionError` (stub returns `[]`)

- [ ] **Step 3: Implement** — replace the stub in `server/src/ports.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx server/src/__tests__/ports.test.ts`
Expected: `ports parsers ok`

- [ ] **Step 5: Commit**

```bash
git add server/src/ports.ts server/src/__tests__/ports.test.ts
git commit -m "feat(ports): match listeners to Crux terminals"
```

---

## Chunk 2: Scanning, routes, terminal pids

### Task 3: `termPids()` in term.ts

**Files:**
- Modify: `server/src/term.ts` (`Entry` at ~line 19, the `const e: Entry = {` literal at ~line 114, new export after `termProcess` at ~line 171)

- [ ] **Step 1:** In `interface Entry`, after `cwd: string;` add:

```ts
  /** Workspace key the terminal was opened in. */
  repo: string;
```

- [ ] **Step 2:** In the `const e: Entry = {` literal in `attachTerm`, after `cwd,` add `repo,`.

- [ ] **Step 3:** After `termProcess`, add:

```ts
/** pty (shell) pid → its terminal and workspace (ports.ts). */
export function termPids(): Map<number, { termId: string; ws: string }> {
  return new Map([...terms].map(([id, e]) => [e.pty.pid, { termId: id, ws: e.repo }]));
}
```

- [ ] **Step 4: Typecheck**

Run: `cd server && npx tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add server/src/term.ts
git commit -m "feat(term): expose pty pids with their workspace"
```

### Task 4: Scan, titles, stop, open-external

**Files:**
- Modify: `server/src/ports.ts` (append)

- [ ] **Step 1:** Add imports at the top of `server/src/ports.ts`:

```ts
import { execFile } from "node:child_process";
import { termPids } from "./term.js";
```

- [ ] **Step 2:** Append to `server/src/ports.ts`:

```ts
/* ---------- scanning (side effects) ---------- */

const WIN = process.platform === "win32";
const WIN_PROCS =
  "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }),$($_.Name)\" }";

const logged = new Set<string>();
/** stdout, or "" on failure (logged once per command). lsof exits 1 when nothing listens. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout: 5000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err && !stdout && !(cmd === "lsof" && (err as { code?: unknown }).code === 1) && !logged.has(cmd)) {
        logged.add(cmd);
        console.warn(`[ports] ${cmd} failed: ${err.message}`);
      }
      resolve(stdout ?? "");
    }),
  );
}

async function scan(): Promise<PortInfo[]> {
  const roots = termPids();
  if (!roots.size) return [];
  let listeners: Listener[];
  let procs: Proc[];
  if (WIN) {
    const [v4, v6, ps] = await Promise.all([
      run("netstat", ["-ano", "-p", "tcp"]),
      run("netstat", ["-ano", "-p", "tcpv6"]),
      run("powershell", ["-NoProfile", "-Command", WIN_PROCS]),
    ]);
    listeners = [...parseNetstat(v4), ...parseNetstat(v6)];
    procs = parseWinProcs(ps);
  } else {
    const [ls, ps] = await Promise.all([
      process.platform === "darwin" ? run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]) : run("ss", ["-ltnpH"]),
      run("ps", ["-A", "-o", "pid=,ppid=,comm="]),
    ]);
    listeners = process.platform === "darwin" ? parseLsof(ls) : parseSs(ls);
    procs = parsePs(ps);
  }
  return matchPorts(listeners, procs, roots);
}

/* Titles: fetched once per port+pid, in the background; shown from the next poll. */
const titles = new Map<string, string | null>();
async function fetchTitle(port: number): Promise<string | null> {
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (!(res.headers.get("content-type") ?? "").includes("html")) return null;
      return parseTitle((await res.text()).slice(0, 64_000)) ?? null;
    } catch {
      /* try the next host */
    }
  }
  return null;
}
function withTitles(ports: PortInfo[]): PortInfo[] {
  return ports.map((p) => {
    const key = `${p.port}:${p.pid}`;
    if (!titles.has(key)) {
      titles.set(key, null);
      void fetchTitle(p.port).then((t) => titles.set(key, t));
    }
    const title = titles.get(key);
    return title ? { ...p, title } : p;
  });
}

let cache = { at: 0, ports: [] as PortInfo[] };
let inflight: Promise<PortInfo[]> | null = null;

/** Last scan if younger than maxAge ms, else a new one (one at a time). */
export function getPorts(maxAge = 2000): Promise<PortInfo[]> {
  if (Date.now() - cache.at < maxAge) return Promise.resolve(withTitles(cache.ports));
  inflight ??= scan()
    .then((ports) => (cache = { at: Date.now(), ports }).ports)
    .finally(() => (inflight = null));
  return inflight.then(withTitles);
}

/** 200 stopped, 404 not a Crux port (any more), 409 it is the terminal's shell and force is off. */
export async function stopPort(pid: number, force: boolean): Promise<200 | 404 | 409> {
  const row = (await getPorts(0)).find((p) => p.pid === pid);
  if (!row) return 404;
  if (row.isShell && !force) return 409;
  if (WIN) {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return 404;
    }
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, 3000);
  }
  cache.at = 0;
  return 200;
}

/** Opens a localhost page in the system browser; false if the URL isn't one. */
export function openExternal(url: string): boolean {
  if (!isLocalUrl(url)) return false;
  if (WIN) execFile("cmd", ["/c", "start", "", url], () => {});
  else execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
  return true;
}
```

- [ ] **Step 3: Tests still pass + typecheck**

Run: `npx tsx server/src/__tests__/ports.test.ts && (cd server && npx tsc --noEmit -p .)`
Expected: `ports parsers ok`, no tsc output.

Note: the test imports `ports.ts`, which now imports `term.ts` (node-pty, config). If that import fails or hangs under tsx, move the parsers into `server/src/portsParse.ts`, re-export them from `ports.ts`, and point the test at `../portsParse.js`.

- [ ] **Step 4: Commit**

```bash
git add server/src/ports.ts
git commit -m "feat(ports): scan listeners, fetch titles, stop and open"
```

### Task 5: Routes

**Files:**
- Modify: `server/src/index.ts` (imports at top; routes after the `/api/preview/:key/status` route, ~line 309)

- [ ] **Step 1:** Add the import next to the preview import:

```ts
import { getPorts, openExternal, stopPort } from "./ports.js";
```

- [ ] **Step 2:** After the `app.get("/api/preview/:key/status", …)` route, add:

```ts
/* ---------- ports (sidebar) ---------- */

app.get("/api/ports", async (_req, res) => {
  res.json(await getPorts());
});
app.post("/api/ports/:pid/stop", async (req, res) => {
  if (!/^\d+$/.test(req.params.pid)) return void res.sendStatus(400);
  const status = await stopPort(Number(req.params.pid), req.body?.force === true);
  res.status(status).json({ ok: status === 200 });
});
app.post("/api/open-external", (req, res) => {
  res.sendStatus(openExternal(String(req.body?.url ?? "")) ? 204 : 400);
});
```

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 4: Manual check against a running server**

1. `npm run dev` (server :8787).
2. In a second shell: `curl -s http://127.0.0.1:8787/api/ports`
   Expected: `[]` (no Crux terminal runs a server yet). If `guardHttp` rejects curl, check from the UI in Task 6 instead.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(ports): list, stop and open-external routes"
```

---

## Chunk 3: Client

### Task 6: `PortsPanel` component

**Files:**
- Create: `client/src/components/PortsPanel.tsx`

- [ ] **Step 1:** Create `client/src/components/PortsPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../net";
import ContextMenu, { MenuIcons } from "./ContextMenu";
import { GlobeIcon } from "./icons";

export interface PortInfo {
  port: number;
  pid: number;
  command: string;
  termId: string;
  ws: string;
  isShell: boolean;
  title?: string;
}

const OPEN_KEY = "crux.portsOpen";
const urlOf = (p: PortInfo) => `http://localhost:${p.port}/`;
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Opens a localhost page in the system browser (server side: Tauri has no opener). */
export const openExternal = (url: string) => post("/api/open-external", { url });

/** Sidebar → Ports: servers started from Crux terminals. Hidden when there are none. */
export default function PortsPanel({
  labels,
  onOpen,
  onToast,
}: {
  /** workspace key → label */
  labels: Record<string, string>;
  onOpen: (url: string) => void;
  onToast: (msg: string) => void;
}) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [menu, setMenu] = useState<null | { p: PortInfo; x: number; y: number }>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/api/ports")
        .then((r) => (r.ok ? r.json() : []))
        .then((p: PortInfo[]) => alive && setPorts(p))
        .catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? "0" : "1");
      } catch {
        /* private window */
      }
      return !o;
    });

  const stop = async (p: PortInfo) => {
    const r = await post(`/api/ports/${p.pid}/stop`, { force: p.isShell }).catch(() => null);
    if (r?.status === 404) onToast(`:${p.port} already stopped`);
    else if (!r?.ok) onToast(`Couldn't stop :${p.port}`);
    setPorts((ps) => ps.filter((x) => x.pid !== p.pid));
  };

  if (!ports.length) return null;
  return (
    <div className="ports-panel">
      <button className="ports-head" onClick={toggle} aria-expanded={open}>
        <span className={`ports-chevron ${open ? "open" : ""}`}>▸</span>
        Ports
        <span className="ports-count">{ports.length}</span>
      </button>
      {open && (
        <div className="ports-list">
          {ports.map((p) => (
            <button
              key={p.port}
              className="ports-row"
              title={`${urlOf(p)} · ${p.command} (pid ${p.pid})`}
              onClick={() => onOpen(urlOf(p))}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ p, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="ports-dot" />
              <span className="ports-port">:{p.port}</span>
              <span className="ports-name">{p.title ?? p.command}</span>
              <span className="ports-ws">{labels[p.ws] ?? p.ws}</span>
            </button>
          ))}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          groups={[
            [
              { label: "Open in system browser", icon: <GlobeIcon />, onSelect: () => void openExternal(urlOf(menu.p)) },
              {
                label: "Copy URL",
                icon: MenuIcons.copy,
                onSelect: () =>
                  void navigator.clipboard.writeText(urlOf(menu.p)).then(
                    () => onToast("Copied URL"),
                    () => onToast("Couldn't copy"),
                  ),
              },
            ],
            [
              {
                // The label is the confirmation for a shell: stopping it closes the terminal.
                label: menu.p.isShell ? "Stop process (closes its terminal)" : "Stop process",
                icon: MenuIcons.trash,
                danger: true,
                onSelect: () => void stop(menu.p),
              },
            ],
          ]}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Check `MenuIcons.copy` / `MenuIcons.trash` are ReactNodes, not components**

Run: `sed -n 85,110p client/src/components/ContextMenu.tsx`
If they are components, use `<MenuIcons.copy />` / `<MenuIcons.trash />` instead. Match how App.tsx uses them (`grep -n "MenuIcons\." client/src/App.tsx | head -3`).

- [ ] **Step 3: Typecheck**

Run: `cd client && npx tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/PortsPanel.tsx
git commit -m "feat(ports): sidebar Ports panel component"
```

### Task 7: Wire into the sidebar + styles

**Files:**
- Modify: `client/src/App.tsx` (import near line 61; render just before `<div className="side-footer">` at ~line 2588)
- Modify: `client/src/styles.css` (after the `.side-footer` rules, ~line 125)

- [ ] **Step 1:** Import in `App.tsx` next to the `ContextMenu` import:

```tsx
import PortsPanel, { openExternal } from "./components/PortsPanel";
```

- [ ] **Step 2:** Immediately before `<div className="side-footer">`, add:

```tsx
          <PortsPanel
            labels={Object.fromEntries(Object.entries(config.repos).map(([k, r]) => [k, r.label]))}
            onOpen={(url) => {
              // The in-app browser when it's there (macOS, view on); else the system browser.
              if (settings.jira && config.browserSupported !== false) {
                setBrowserOpen({ url, nonce: Date.now() });
                setView("jira");
              } else void openExternal(url);
            }}
            onToast={setToast}
          />
```

- [ ] **Step 3:** In `styles.css`, after `.side-footer > .settings-btn { margin-left: auto; }`, add:

```css
/* sidebar → Ports (servers started from Crux terminals) */
.ports-panel { margin-top: auto; border-top: 1px solid var(--line); padding: 4px 6px; min-height: 0; display: flex; flex-direction: column; max-height: 40%; }
.ports-panel + .side-footer { margin-top: 0; }
.ports-head {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 4px;
  background: none; border: none; color: var(--ink-faint); font: inherit; font-size: 11.5px;
  cursor: pointer; text-align: left; flex: none;
}
.ports-head:hover { color: var(--ink); }
.ports-chevron { display: inline-block; transition: transform .12s; font-size: 9px; }
.ports-chevron.open { transform: rotate(90deg); }
.ports-count { margin-left: auto; font-size: 10.5px; }
.ports-list { overflow-y: auto; min-height: 0; }
.ports-row {
  display: flex; align-items: center; gap: 7px; width: 100%; padding: 4px 6px; border-radius: 6px;
  background: none; border: none; color: var(--ink-soft); font: inherit; font-size: 12px;
  cursor: pointer; text-align: left; min-width: 0;
}
.ports-row:hover { background: var(--surface-2); color: var(--ink); }
.ports-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pass, #3fb950); flex: none; }
.ports-port { font-variant-numeric: tabular-nums; flex: none; }
.ports-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ports-ws { margin-left: auto; color: var(--ink-faint); font-size: 11px; flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

Before saving, check `--pass` exists: `grep -n "\-\-pass\b\|--ok\b\|--success" client/src/styles.css client/src/themes.css | head -3` and use whichever green token the app defines.

- [ ] **Step 4: Typecheck**

Run: `cd client && npx tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 5: Manual verification**

1. `npm run dev`, open `http://localhost:5180`.
2. In a Crux terminal: `python3 -m http.server 8123`.
   Expected within 3 s: Ports section above the footer shows `● :8123  Directory listing for /  <workspace>`.
3. Click the chevron → collapses; reload → stays collapsed. Click again to expand.
4. Click the row → opens in the browser pane (macOS with Browser view on) or system browser.
5. Right-click → Copy URL → toast "Copied URL".
6. Right-click → Stop process → row disappears, python exits in the terminal, terminal stays open.
7. In a Crux terminal: `exec python3 -m http.server 8124` → right-click shows "Stop process (closes its terminal)".
8. With no servers running, the section is gone.

- [ ] **Step 6: Commit** (only the ports hunks; these files have unrelated uncommitted edits)

Precondition (checked before Task 7 starts): the user's own App.tsx / styles.css edits are committed or stashed, so these files contain only ports changes.

```bash
git add client/src/App.tsx client/src/styles.css
git diff --cached --stat   # App.tsx and styles.css only, small line counts
git commit -m "feat(ports): show running ports above the sidebar footer"
```
