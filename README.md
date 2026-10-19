# Crux

A desktop workbench for coding agents. Run Claude Code, Codex and plain
terminals side by side across all your projects, see at a glance which agent
is working, waiting for you or done, and give them a browser, a screenshot or
a whole team to work with.

Runs on macOS, Linux and Windows.

## What you get

- **Workspaces**: add any folder. Each gets its own chats, and every chat its
  own terminals and splits (drag a tab or the Claude / Codex / Terminal
  launchers onto a pane edge to split).
- **Session tabs**: one tab bar for every open session across workspaces, with
  a working / needs-input / finished dot. ⌘1–9 to switch, ⌘W to close, ⌘⇧T to
  reopen. The **Sessions** view lists past Claude and Codex chats to resume.
- **Know when an agent needs you**: notifications, a menu bar panel with each
  agent's latest message, and a Home screen of what's open and waiting.
- **Orchestrate**: describe a task, pick how many agents, and a lead agent
  splits it, runs the workers in their own git worktrees, and merges the result.
- **Browser** (macOS): a real browser beside your chats that agents can drive
  through MCP tools; tabs, bookmarks, downloads, import logins from Arc or Chrome,
  and ⌘⇧C to mark an issue on a page for an agent.
- **Screenshot to agent**: from the menu bar, grab part of the screen and send
  it to any chat.
- **Quick Ask** (⌥Space): ask an agent from any app.
- **Search** (⌘K) across open and past chats.
- Optional panels for documentation previews (MkDocs), test trees and
  scheduled GitLab pipelines, for workspaces that have them.

## Install

Download the latest release from
[Releases](https://github.com/lvdins/crux/releases):

| System | File |
|---|---|
| macOS (Apple silicon) | `Crux_<version>_aarch64.dmg` |
| Linux | `Crux_<version>_amd64.AppImage` (updates itself) or `.deb` |
| Windows | `Crux_<version>_x64-setup.exe` |

Crux checks for new versions and offers to update itself (the AppImage, DMG and
Windows installer; a `.deb` updates by installing the new package).

You need the agents you want to use installed and logged in:
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or
[Codex](https://github.com/openai/codex). Settings → Setup checks what's
missing and offers to install it.

## Develop

```bash
npm install
npm run dev          # server :8787 + UI on vite :5180, in a browser
npm run app:dev      # desktop app (Tauri) against a separate dev profile
npm run app:build    # release bundle in src-tauri/target/release/bundle
```

Needs Node 20+ and, for the desktop app, the Rust toolchain.

| Dir | What |
|---|---|
| `client/` | React + Vite UI. |
| `server/` | Node (Express + WebSocket) backend: terminals (node-pty), agent hooks and MCP tools, updates. |
| `server/mcp/` | MCP servers agents get: the browser tools and the orchestrator's team tools. |
| `src-tauri/` | Tauri 2 desktop shell: windows, menu bar panel, native browser panes, screenshots. |
| `scripts/` | Bundling the server and Node runtime into the app. |

Releases: publishing a GitHub release builds the Linux and Windows files in
GitHub Actions and attaches them; the macOS DMG is built locally.

## Notes

- The server listens on `127.0.0.1` only and accepts requests from the Crux
  window and local programs; nothing on your network can reach your terminals.
- Agents run with your own Claude Code / Codex settings and permissions. Crux
  adds hooks (to know when a turn finishes) and MCP tools; it doesn't change
  your config files.
- Your data stays local: workspaces, chats and settings live in `~/.crux`.
