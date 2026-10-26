# Sidebar: running ports

## Goal

A collapsible **Ports** section in the lower half of the sidebar, directly
above the footer (avatar / nickname / settings). It lists TCP ports that
processes started from Crux terminals are listening on, so a dev server an
agent or the user started is one click away.

## Scope

In:
- Only ports owned by a process that descends from a Crux terminal's pty.
- Row: status dot, `:port`, command name, page `<title>` (if any), workspace.
- Click → open `http://localhost:<port>` in the Crux browser pane.
- Right-click → Open in system browser, Copy URL, Stop process.
- macOS, Linux, Windows.

Out:
- Thumbnails / screenshots.
- Ports not started from Crux (Postgres, Docker, other apps).
- A Settings toggle (the section hides itself when empty).

## Server

### `server/src/term.ts`
`Entry` gains `repo: string` (the workspace key `attachTerm` already receives
and currently drops). New export
`termPids(): Map<number, { termId: string; ws: string }>` — pty pid → owning
terminal and workspace, for every live terminal.

### `server/src/ports.ts` (new)

```ts
export interface PortInfo {
  port: number;
  pid: number;
  command: string;      // process name, e.g. "node", "vite", "python3"
  termId: string;       // owning Crux terminal
  ws: string;           // workspace key of that terminal
  isShell: boolean;     // listener IS the pty process (stopping it ends the terminal)
  title?: string;       // <title> of the page, when it serves HTML
}
```

Pure, tested functions:
- `parseLsof(out)` → `{ port, pid }[]`. `-F pn` output is `p<pid>` then
  repeated `f<fd>` / `n<addr>` lines; skip `f`, read the port after the last `:`
  of each `n` line.
- `parseSs(out)` → `{ port, pid }[]`. One line can list several
  `users:(("node",pid=N,fd=M),…)`; take every pid.
- `parseNetstat(out)` → `{ port, pid }[]`. A row is a listener when its
  foreign address is `0.0.0.0:0` or `[::]:0` (the state column is localized,
  never match on `LISTENING`).
- `parsePs(out)` → `{ pid, ppid, command }[]`; `command` is the basename
  (macOS `comm` is a full path; Linux truncates to 15 chars).
- `parseWinProcs(csv)` → `{ pid, ppid, command, created }[]`.
- `matchPorts(listeners, procs, roots)` → `PortInfo[]`: walk each
  listener's ppid chain until it hits a root pid (stop at 0/1/unknown, guard
  against cycles). On Windows a parent link only counts if the parent's
  `created` is earlier than the child's (pid reuse). One row per port
  (IPv4 + IPv6 collapse), sorted by port.

All processes under a terminal are listed, including helper ports of Claude /
Codex / MCP servers — no filtering in v1. Filtering by command name can come
later if that turns out noisy.

Side-effecting:
- `scanPorts()` runs the platform commands:
  - macOS: `lsof -nP -iTCP -sTCP:LISTEN -F pn` + `ps -A -o pid=,ppid=,comm=`.
    lsof exits 1 when nothing listens: exit 1 with empty stdout = `[]`, not
    an error.
  - Linux: `ss -ltnpH` (shows pids of the user's own processes without root)
    + `ps -A -o pid=,ppid=,comm=`
  - Windows: `netstat -ano -p tcp` **and** `netstat -ano -p tcpv6` + PowerShell
    `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Csv`
- Titles: fetch `http://127.0.0.1:<port>/`, then `http://[::1]:<port>/` if
  that fails; 1 s timeout each, regex `<title>(.*?)</title>`, entity-decoded,
  cached by `port:pid`. Failures cache as "no title" so a port is fetched at
  most once per process.
- `getPorts()` returns the last scan; a scan runs on demand when the cached
  one is older than 2 s, with at most one scan in flight.

### Routes (`server/src/index.ts`)
Both sit behind the existing `guardHttp` middleware like every `/api` route.
- `GET /api/ports` → `PortInfo[]`.
- `POST /api/ports/:pid/stop`: `pid` must match `^\d+$`. Run a **fresh**
  scan (not the cached one) and require the pid in it, else 404. If the row
  is `isShell`, 409 unless the body has `{ force: true }` (the client asks
  "This closes the terminal too. Stop?"). Then SIGTERM, SIGKILL after 3 s if
  still alive (Windows: `taskkill /PID <pid> /T /F`).
- `POST /api/open-external` `{ url }`: only `http://localhost:<port>…`,
  `http://127.0.0.1:<port>…` or `http://[::1]:<port>…`; runs `open` (macOS),
  `xdg-open` (Linux) or `cmd /c start "" <url>` (Windows). There is no
  system-browser path in Tauri today.

## Client

### `client/src/components/PortsPanel.tsx` (new)
- Polls `/api/ports` every 3 s with the existing `api()` helper.
- Header button: chevron + "Ports" + count. Toggles open/closed; state in
  `localStorage["crux.portsOpen"]` (try/catch, default open).
- Rows as described above; workspace label muted. The list scrolls inside
  itself once taller than ~40 % of the sidebar.
- Hidden entirely when the list is empty.
- Right-click → `ContextMenu` (existing component) with the three actions.
  Stop failure → `setToast` (App.tsx). `isShell` rows confirm first, then
  retry with `force: true`.

### `client/src/App.tsx`
Render `<PortsPanel … />` immediately before `<div className="side-footer">`
(App.tsx:2588), passing:
- `openUrl` — the same logic as the existing `onOpenUrl` (opens the browser
  pane via `setBrowserOpen` + view switch) **when the browser is available**
  (`settings.browser`, macOS only).
- When the browser pane isn't available (Linux, Windows, or browser off),
  a row click calls `/api/open-external` instead.

### Styles
In `styles.css`, next to the `.side-footer` rules, using existing tokens.

## Errors
- Scan command missing / fails → log once, return `[]`, UI stays hidden.
- Title fetch fails → row without title.
- Stop on a pid no longer listed → 404, row disappears on next poll.

## Tests
`server/src/__tests__/ports.test.ts` (`node:assert`, run with `npx tsx`, like `activity.test.ts`):
- Each parser against captured fixture output: lsof with `f` lines and
  several fds per pid; ss with several `users` pids on one line; netstat
  IPv4 + IPv6 rows with a non-English state column; macOS `ps` full-path
  `comm`.
- `matchPorts`: direct child, grandchild, unrelated process excluded,
  listener = pty pid sets `isShell`, duplicate IPv4/IPv6 collapsed, ppid
  cycle doesn't hang, Windows reused parent pid (newer `created`) rejected.
- `isLocalUrl` guard for `/api/open-external`: accepts the three localhost
  forms, rejects other hosts, `file:`, and `localhost.evil.com`.
