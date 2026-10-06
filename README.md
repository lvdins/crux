# Crux

Chat-driven QA workbench: talk to a Claude agent that works directly in the QA
repos, with a live MkDocs preview and a test tree beside the conversation.

## Pieces

| Dir | What |
|---|---|
| `server/` | Express + WebSocket backend (:8787). Runs Claude Agent SDK sessions (one per repo, resumed turn-by-turn), spawns `mkdocs serve` via uv, scans the Playwright/pytest suites into the test tree. Serves the built client. |
| `client/` | React/Vite UI (:5180 in dev). Chat left; Doc preview / Test tree tabs right. |
| `src-tauri/` | Tauri 2 desktop shell (same stack as platform-lab). Spawns the server if :8787 is not already up. |
| `crux.config.json` | Repo paths, agent permission mode, preview port. Edit paths here. |

## Run

```bash
npm install

# browser mode
npm run dev          # server :8787 + vite :5180

# desktop app
npm run app:dev      # Tauri dev window
npm run app:build    # .app / .dmg in src-tauri/target/release/bundle
```

Requirements: Node 20+, `uv` (for mkdocs preview), Rust toolchain (desktop app
only), and a logged-in Claude Code install (the Agent SDK uses its credentials).

## Notes

- `agent.permissionMode` is `bypassPermissions` — the agent can run any shell
  command in the selected repo without confirmation. Local trusted use only.
- Switching repo in the header starts a fresh agent conversation with that
  repo as cwd.
