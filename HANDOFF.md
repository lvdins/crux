# Crux — handoff for continuing in another chat

Paste this whole file into the new chat as the first message.

## What Crux is
A macOS desktop QA workbench (formerly "QualityLab", originally "SuperQA") for a QA engineer at Giraffe360.
Per-repo **workspaces** with terminals where you run **Claude Code / Codex**, plus panels for docs preview,
test trees, test coverage, a feature map of the product, Jira, and an in-app browser that the agents can drive.

- Repo: local git, branch `qa-doc-builder`, worktree `~/.superset/worktrees/SuperQA/estimated-epoxy`
  (no git remote yet). Last commit: `c9a95fb`.
- User-facing install guide: `INSTALL.md`. Build: `npm run app:build` → `src-tauri/target/release/bundle/dmg/Crux_0.1.0_aarch64.dmg`.

## Architecture
- **server/** — Node/Express + `ws` on **:8787** (`npm run start -w server`; never `tsx watch`, it wedges with PTYs).
  - `term.ts` PTYs (node-pty) keyed by tab id; boot commands via `zsh -il -c "<cmd>; exec zsh -il"`.
  - `config.ts` workspaces in `~/.crux/config.json` (auto-migrated from `~/.qualitylab`); kind detection:
    mkdocs / playwright / pytest / frontend (Next.js/nx) / backend (Django) / generic.
  - `features.ts` (`/api/features`) feature map: dashboard modules → pages + `/gapi` endpoints → Django views
    (parsed URL conf) → API tests (pytest route classes) → E2E tests (Playwright).
  - `agent-setup.ts` shell integration: `ZDOTDIR=~/.crux/zsh` wraps `claude` (`--mcp-config`) and `codex`
    (`-c mcp_servers.crux_browser…`) so agents get the **crux-browser** MCP tools.
  - `mcp/browser-mcp.mjs` stdio MCP server (navigate, snapshot with [ref]s, click, type, press_key,
    select_option, wait_for, screenshot, evaluate, back/forward/reload) → `POST /api/agent-browser/:ws`
    → relayed over WS to the desktop window.
  - Other endpoints: `/api/tree`, `/api/system` (tool checklist), `/api/workspaces/*` (add/patch/delete,
    reveal, branch, branches, trash), `/api/term/:id/process`, `/api/preview/:key/*`.
- **client/** — React + Vite on **:5180**, `App.tsx` is the shell.
  - Terminals: xterm cached outside React (`Term.tsx`), bundled Nerd Font, split tree (`paneLayout.ts`)
    with per-pane tabs; drag Claude/Codex onto a pane edge to split, centre for a tab.
  - Right panel per workspace: Doc preview / Tests / Coverage / Browser.
  - Browser (`Browser.tsx`): native child webviews with tabs, bookmarks, collapsible address bar,
    element inspector with Playwright locators (`elementPicker.ts`), Network checker (`netRecorder.js`,
    `NetworkPanel.tsx`), Web Inspector button.
  - Connections view: Coverage list + galaxy Graph (`FeatureMap.tsx`, `FeatureGraph.tsx`).
  - Jira view: saved boards (`JiraMenu.tsx`), open Jira tabs listed in the sidebar.
  - Git menu in the terminal tab bar (`GitMenu.tsx`): actions + branch switcher, sent to the focused terminal
    (short prompt for agents, git command for shells).
  - Sidebar: workspaces (right-click: pin, rename, colour, open in Finder, copy path/branch, unread,
    remove, delete-to-Trash), collapsible Views. Shortcuts: ⌘S sidebar, ⌘B right panel.
- **src-tauri/** — Tauri 2 (`unstable` multi-webview). `main.rs` starts the bundled server when packaged
  (`Resources/ql-runtime`, built by `scripts/bundle-server.mjs`) and adds the View menu shortcuts.
  `browser.rs` native panes via objc2/WebKit: exact placement against the main webview's CSS viewport,
  JS eval (`callAsyncJavaScript`, isolated world), snapshots, devtools (detached inspector).

## Run (dev)
```sh
npm install
npm run start -w server        # :8787
npm run app:dev                 # Tauri dev window (starts Vite :5180)
```

## Gotchas
- Bundle identifier stays `com.giraffe360.qualitylab` on purpose: changing it wipes WebKit logins/localStorage.
- Never type into a fresh PTY (p10k drops typed-ahead input); use bootCmd.
- React StrictMode double-mounts: Term must not gate on "first mount".
- Server changes need a server restart, which closes all terminal tabs — ask the user first.
- Native webviews float above HTML: hide them while menus/modals are open (`overlayOpen` in App).
- Homebrew node can't be bundled (dynamic libs); bundle script downloads nodejs.org's build.
- Tauri resource folder must not share the binary name (hence `ql-runtime`).
- In this shell, `cd … && git …` hangs (hook); use `git -C <repo>`.

## User preferences
- Iterates fast with screenshots; wants changes applied live, then a short summary.
- Likes Superset-style neutral dark UI (now a softer charcoal), smooth animations, no emojis.
- Asks for "restart" explicitly when terminals may be closed.

## Open ideas (not started)
- Dock icon alternative (black mark on white) if preferred.
- Re-wrap terminals only on drag release for even smoother splitter drags.
- Universal (Intel) build; Apple Developer ID signing to drop the `xattr` step.
