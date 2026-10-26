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
New export `termPids(): Map<number, string>` — pty pid → terminal id, for
every live terminal.

### `server/src/ports.ts` (new)

```ts
export interface PortInfo {
  port: number;
  pid: number;
  command: string;      // process name, e.g. "node", "vite", "python3"
  termId: string;       // owning Crux terminal
  title?: string;       // <title> of http://127.0.0.1:port, when it serves HTML
}
```

Pure, tested functions:
- `parseLsof(out)`, `parseSs(out)`, `parseNetstat(out)` → `{ port, pid }[]`
- `parsePs(out)` / `parseWinProcs(out)` → `{ pid, ppid, command }[]`
- `matchPorts(listeners, procs, roots: Map<pid, termId>)` → `PortInfo[]`:
  walk each listener's ppid chain until it hits a root pid (or 1/0/unknown,
  guarded against cycles). One row per port; if a process listens on both
  IPv4 and IPv6 the port appears once. Sorted by port.

Side-effecting:
- `scanPorts()` runs the platform commands:
  - macOS: `lsof -nP -iTCP -sTCP:LISTEN -F pn` + `ps -A -o pid=,ppid=,comm=`
  - Linux: `ss -ltnpH` + `ps -A -o pid=,ppid=,comm=`
  - Windows: `netstat -ano -p tcp` + PowerShell
    `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name | ConvertTo-Csv`
- Titles: `fetch("http://127.0.0.1:<port>/")`, 1 s timeout, regex
  `<title>(.*?)</title>`, HTML-entity-decoded, cached by `port:pid`. Failures
  cache as "no title" so a port is fetched at most once per process.
- `getPorts()` returns the last scan; a scan runs on demand when the cached
  one is older than 2 s, with at most one scan in flight.

### Routes (`server/src/index.ts`)
- `GET /api/ports` → `PortInfo[]` (plus workspace key derived from termId the
  same way other routes map terminals to workspaces).
- `POST /api/ports/:pid/stop` → only if `pid` is in the current list:
  SIGTERM, then SIGKILL after 3 s if still alive (Windows: `taskkill /PID /T /F`).
  Otherwise 404.

## Client

### `client/src/components/PortsPanel.tsx` (new)
- Polls `/api/ports` every 3 s with the existing `api()` helper.
- Header button: chevron + "Ports" + count. Toggles open/closed; state in
  `localStorage["crux.portsOpen"]` (try/catch, default open).
- Rows as described above; workspace label muted. The list scrolls inside
  itself once taller than ~40 % of the sidebar.
- Hidden entirely when the list is empty.
- Right-click → `ContextMenu` (existing component) with the three actions.
  Stop failure → existing toast/notify path.

### `client/src/App.tsx`
Render `<PortsPanel … />` immediately before `<div className="side-footer">`,
passing an `openUrl` callback that opens the URL in the browser pane.

### Styles
In `styles.css`, next to the `.side-footer` rules, using existing tokens.

## Errors
- Scan command missing / fails → log once, return `[]`, UI stays hidden.
- Title fetch fails → row without title.
- Stop on a pid no longer listed → 404, row disappears on next poll.

## Tests
`server/src/__tests__/ports.test.ts` (`node:assert`, run with `npx tsx`, like `activity.test.ts`):
- Each parser against captured fixture output (incl. IPv6, `*:port`,
  `[::1]:port`).
- `matchPorts`: direct child, grandchild, unrelated process excluded,
  duplicate IPv4/IPv6 collapsed, ppid cycle doesn't hang.
