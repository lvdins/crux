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

// UserPromptSubmit / PostToolUse = Claude is working; Stop = it finished its
// turn; Notification = it needs your input or permission. The hook's own JSON
// (prompt, tool, message, transcript) is passed on as the body: see hookDetail.
const report = (event: string) =>
  `[ -n "$CRUX_TERM" ] && curl -s -m 2 -X POST -H 'Content-Type: application/json' ` +
  `--data-binary @- "$CRUX_URL/api/agent-event?term=$CRUX_TERM&event=${event}" >/dev/null 2>&1; true`;

// Older claude CLIs reject --settings: then chats start without the hooks.
let hooksSupported = true;
execFile("claude", ["--help"], { timeout: 15000 }, (err, out) => {
  if (!err) hooksSupported = /--settings\b/.test(out);
});

function writeHooks(): void {
  const hook = (event: string) => [{ hooks: [{ type: "command", command: report(event) }] }];
  const cfg = {
    hooks: { UserPromptSubmit: hook("working"), PostToolUse: hook("working"), Stop: hook("stop"), Notification: hook("input") },
  };
  fs.writeFileSync(HOOKS_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

/** One line, at most `max` characters. */
const oneLine = (text: string, max = 80) => {
  // Drop markdown emphasis / code ticks and heading or quote marks (not underscores: file names).
  const flat = text.replace(/[`*]+/g, "").replace(/^\s*[#>]+\s*/gm, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

/** Claude's last reply in a transcript (JSONL): read from the end only. */
function lastReply(transcript: string): string {
  try {
    const fd = fs.openSync(transcript, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "assistant") continue;
        const content = entry.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join(" ") : "";
        if (text.trim()) return text;
      } catch {
        /* partial first line */
      }
    }
  } catch {
    /* transcript gone */
  }
  return "";
}

/** What a tool call is doing, e.g. "Bash: npm test", "Edit: App.tsx". */
function toolLine(name: string, input: Record<string, unknown> = {}): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const detail =
    str("description") && name !== "Bash"
      ? str("description")
      : str("command") || (str("file_path") && path.basename(str("file_path"))) || str("pattern") || str("url") || str("query") || str("description");
  return detail ? `${name}: ${detail}` : name;
}

/**
 * A short line for the menu bar about a Claude hook event: your prompt, the
 * tool it just ran, what it needs from you, or its last reply.
 */
export function hookDetail(event: string, hook: Record<string, unknown>): string {
  const str = (k: string) => (typeof hook[k] === "string" ? (hook[k] as string) : "");
  let text = "";
  if (event === "input") text = str("message");
  else if (event === "stop") text = str("last_assistant_message") || (str("transcript_path") && lastReply(str("transcript_path")));
  else if (str("prompt")) text = `You: ${str("prompt")}`;
  else if (str("tool_name")) text = toolLine(str("tool_name"), hook.tool_input as Record<string, unknown>);
  return text ? oneLine(text) : "";
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
