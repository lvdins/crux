# Installing QualityLab

QualityLab is a desktop QA workbench: terminals with Claude / Codex per repo,
docs preview, test trees, coverage, a feature map of the dashboard, and a
built-in browser the agent can drive.

## Requirements

- Apple Silicon Mac (M1 or newer), macOS 12+
- Command-line tools QualityLab uses (the first-run screen checks these and
  shows the install command for anything missing):
  | Tool | Used for | Install |
  |---|---|---|
  | git | branch names | `xcode-select --install` |
  | claude | Claude button / agent terminals | `npm install -g @anthropic-ai/claude-code` |
  | codex | Codex button | `npm install -g @openai/codex` |
  | uv | docs preview (MkDocs) | `brew install uv` |
  | node | running Playwright tests | `brew install node` |

## Install

1. Open `QualityLab_<version>_aarch64.dmg` and drag **QualityLab** into **Applications**.
2. The app isn't signed with an Apple Developer ID yet, so macOS blocks the
   first launch ("damaged" or "can't be opened"). Clear the download flag once:
   ```sh
   xattr -dr com.apple.quarantine /Applications/QualityLab.app
   ```
3. Open QualityLab.

## First run

1. Click **+ Add workspace** and pick each repo folder you work in. Nothing is
   copied; QualityLab works on the folders where they are. The type is
   detected automatically:
   - MkDocs docs → docs preview
   - Playwright → E2E test tree + coverage
   - pytest → API test tree + coverage
   - Next.js dashboard (Frontend) and Django backend → used by **Connections**
2. Add the dashboard and backend repos too to unlock **Connections**
   (feature coverage map and graph).
3. Open a terminal tab and click **Claude** or **Codex**. Agents started in
   QualityLab terminals can also drive the **Browser** tab (ask them to "use
   the qualitylab-browser tools").

## Where things live

- Your workspaces and settings: `~/.qualitylab/config.json` (per user)
- Server log, if something won't start: `~/.qualitylab/server.log`
- Shortcuts: **⌘S** toggles the sidebar, **⌘⇧⌫** deletes the open workspace (asks first)

## Building it yourself

```sh
npm install
npm run app:build   # → src-tauri/target/release/bundle/dmg/QualityLab_*.dmg
```
`app:build` bundles the server, an official Node runtime and node-pty into
the app (`scripts/bundle-server.mjs`), so recipients don't need this repo.
