import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { rootPath } from "./paths.js";

/**
 * Gives claude / codex started in a QualityLab terminal the
 * qualitylab-browser MCP tools, scoped to that terminal's workspace.
 *
 * zsh shells get ZDOTDIR pointed at ~/.qualitylab/zsh, whose startup files
 * source the user's own files first and then wrap `claude` / `codex` with
 * the MCP config. Nothing in the user's dotfiles or repos is modified.
 */

const home = path.join(os.homedir(), ".qualitylab");
export const ZSH_DIR = path.join(home, "zsh");
const MCP_DIR = path.join(home, "mcp");
export const BROWSER_MCP = rootPath("server", "mcp", "browser-mcp.mjs");
const SERVER_URL = "http://127.0.0.1:8787";

export const mcpConfigPath = (ws: string) => path.join(MCP_DIR, `${ws}.json`);

export function writeMcpConfig(ws: string): void {
  fs.mkdirSync(MCP_DIR, { recursive: true });
  const cfg = {
    mcpServers: {
      "qualitylab-browser": {
        type: "stdio",
        command: process.execPath,
        args: [BROWSER_MCP],
        env: { QUALITYLAB_WORKSPACE: ws, QUALITYLAB_URL: SERVER_URL },
      },
    },
  };
  fs.writeFileSync(mcpConfigPath(ws), JSON.stringify(cfg, null, 2) + "\n");
}

// Forward one zsh startup file to the user's own copy.
const forward = (file: string) => `# QualityLab shell integration: load your own ${file} first.
__ql_zdotdir=$ZDOTDIR
ZDOTDIR=\${QL_USER_ZDOTDIR:-$HOME}
[[ -f "$ZDOTDIR/${file}" ]] && source "$ZDOTDIR/${file}"
ZDOTDIR=$__ql_zdotdir
unset __ql_zdotdir
`;

const ZSHRC = `${forward(".zshrc")}
# claude / codex get the qualitylab-browser tools for this workspace.
if [[ -n "$QUALITYLAB_MCP_CONFIG" && -f "$QUALITYLAB_MCP_CONFIG" ]]; then
  claude() {
    case "$1" in
      mcp|config|update|doctor|install|setup-token|migrate-installer|plugin|plugins|auth|-v|--version|-h|--help)
        command claude "$@" ;;
      *)
        command claude --mcp-config "$QUALITYLAB_MCP_CONFIG" "$@" ;;
    esac
  }
  codex() {
    command codex \\
      -c "mcp_servers.qualitylab_browser.command=\\"$QL_NODE\\"" \\
      -c "mcp_servers.qualitylab_browser.args=[\\"$QL_BROWSER_MCP\\"]" \\
      -c "mcp_servers.qualitylab_browser.env={QUALITYLAB_WORKSPACE=\\"$QUALITYLAB_WORKSPACE\\",QUALITYLAB_URL=\\"$QUALITYLAB_URL\\"}" \\
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
  for (const ws of Object.keys(config.repos)) writeMcpConfig(ws);
}

/** Extra environment for a workspace terminal. */
export function agentEnv(ws: string, shell: string): Record<string, string> {
  const env: Record<string, string> = {
    QUALITYLAB_WORKSPACE: ws,
    QUALITYLAB_URL: SERVER_URL,
    QUALITYLAB_MCP_CONFIG: mcpConfigPath(ws),
    QL_NODE: process.execPath,
    QL_BROWSER_MCP: BROWSER_MCP,
  };
  if (path.basename(shell) === "zsh") {
    env.QL_USER_ZDOTDIR = process.env.ZDOTDIR || os.homedir();
    env.ZDOTDIR = ZSH_DIR;
  }
  return env;
}
