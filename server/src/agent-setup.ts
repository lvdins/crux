import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { CRUX_HOME, SERVER_URL, rootPath } from "./paths.js";

/**
 * Gives claude / codex started in a Crux terminal the
 * crux-browser MCP tools, scoped to that terminal's workspace.
 *
 * zsh shells get ZDOTDIR pointed at ~/.crux/zsh, whose startup files
 * source the user's own files first and then wrap `claude` / `codex` with
 * the MCP config. Nothing in the user's dotfiles or repos is modified.
 */

const home = CRUX_HOME;
export const ZSH_DIR = path.join(home, "zsh");
const MCP_DIR = path.join(home, "mcp");
export const BROWSER_MCP = rootPath("server", "mcp", "browser-mcp.mjs");

export const mcpConfigPath = (ws: string) => path.join(MCP_DIR, `${ws}.json`);
/** Claude Code settings Crux adds (`--settings`): hooks that tell Crux when a turn ends. */
export const HOOKS_PATH = path.join(home, "claude-hooks.json");

// Stop = Claude finished its turn; Notification = it needs your input or permission.
const report = (event: string) =>
  `[ -n "$CRUX_TERM" ] && curl -s -m 2 -X POST -H 'Content-Type: application/json' ` +
  `-d "{\\"term\\":\\"$CRUX_TERM\\",\\"event\\":\\"${event}\\"}" "$CRUX_URL/api/agent-event" >/dev/null 2>&1; true`;

// Older claude CLIs reject --settings: then chats start without the hooks.
let hooksSupported = true;
execFile("claude", ["--help"], { timeout: 15000 }, (err, out) => {
  if (!err) hooksSupported = /--settings\b/.test(out);
});

function writeHooks(): void {
  const hook = (event: string) => [{ hooks: [{ type: "command", command: report(event) }] }];
  const cfg = { hooks: { Stop: hook("stop"), Notification: hook("input") } };
  fs.writeFileSync(HOOKS_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function writeMcpConfig(ws: string): void {
  fs.mkdirSync(MCP_DIR, { recursive: true });
  const cfg = {
    mcpServers: {
      "crux-browser": {
        type: "stdio",
        command: process.execPath,
        args: [BROWSER_MCP],
        env: { CRUX_WORKSPACE: ws, CRUX_URL: SERVER_URL },
      },
    },
  };
  fs.writeFileSync(mcpConfigPath(ws), JSON.stringify(cfg, null, 2) + "\n");
}

// Forward one zsh startup file to the user's own copy.
const forward = (file: string) => `# Crux shell integration: load your own ${file} first.
__ql_zdotdir=$ZDOTDIR
ZDOTDIR=\${QL_USER_ZDOTDIR:-$HOME}
[[ -f "$ZDOTDIR/${file}" ]] && source "$ZDOTDIR/${file}"
ZDOTDIR=$__ql_zdotdir
unset __ql_zdotdir
`;

const ZSHRC = `${forward(".zshrc")}
# claude / codex get the crux-browser tools for this workspace.
if [[ -n "$CRUX_MCP_CONFIG" && -f "$CRUX_MCP_CONFIG" ]]; then
  claude() {
    case "$1" in
      mcp|config|update|doctor|install|setup-token|migrate-installer|plugin|plugins|auth|-v|--version|-h|--help)
        command claude "$@" ;;
      *)
        local hooks=()
        [[ -f "$CRUX_HOOKS" ]] && hooks=(--settings "$CRUX_HOOKS")
        command claude --mcp-config "$CRUX_MCP_CONFIG" "\${hooks[@]}" "$@" ;;
    esac
  }
  codex() {
    command codex \\
      -c "mcp_servers.crux_browser.command=\\"$QL_NODE\\"" \\
      -c "mcp_servers.crux_browser.args=[\\"$QL_BROWSER_MCP\\"]" \\
      -c "mcp_servers.crux_browser.env={CRUX_WORKSPACE=\\"$CRUX_WORKSPACE\\",CRUX_URL=\\"$CRUX_URL\\"}" \\
      "$@"
  }
fi
`;

export function installAgentSetup(): void {
  fs.mkdirSync(ZSH_DIR, { recursive: true });
  fs.writeFileSync(path.join(ZSH_DIR, ".zshenv"), forward(".zshenv"));
  fs.writeFileSync(path.join(ZSH_DIR, ".zprofile"), forward(".zprofile"));
  fs.writeFileSync(path.join(ZSH_DIR, ".zlogin"), forward(".zlogin"));
  fs.writeFileSync(path.join(ZSH_DIR, ".zshrc"), ZSHRC);
  writeHooks();
  for (const ws of Object.keys(config.repos)) writeMcpConfig(ws);
}

/** Extra environment for a workspace terminal. */
export function agentEnv(ws: string, shell: string, term: string): Record<string, string> {
  const env: Record<string, string> = {
    CRUX_WORKSPACE: ws,
    CRUX_TERM: term,
    CRUX_HOOKS: hooksSupported ? HOOKS_PATH : "",
    CRUX_URL: SERVER_URL,
    CRUX_MCP_CONFIG: mcpConfigPath(ws),
    QL_NODE: process.execPath,
    QL_BROWSER_MCP: BROWSER_MCP,
  };
  if (path.basename(shell) === "zsh") {
    env.QL_USER_ZDOTDIR = process.env.ZDOTDIR || os.homedir();
    env.ZDOTDIR = ZSH_DIR;
  }
  return env;
}
