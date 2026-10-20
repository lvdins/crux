import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_SUPPORTED, config } from "./config.js";
import { CRUX_HOME, SERVER_URL, rootPath } from "./paths.js";
import { leadMcpConfig } from "./orchestrator.js";

/**
 * Gives claude / codex started in a Crux terminal the
 * crux-browser MCP tools, scoped to that terminal's workspace.
 *
 * zsh shells get ZDOTDIR pointed at ~/.crux/zsh, whose startup files
 * source the user's own files first and then wrap `claude` / `codex` with
 * the MCP config. Other shells (bash on Linux, fish, …) get the same through
 * small `claude` / `codex` scripts in ~/.crux/bin, put first on PATH.
 * Nothing in the user's dotfiles or repos is modified.
 */

const home = CRUX_HOME;
export const ZSH_DIR = path.join(home, "zsh");
const MCP_DIR = path.join(home, "mcp");
/** `claude` / `codex` wrappers for shells other than zsh. */
export const BIN_DIR = path.join(home, "bin");
export const BROWSER_MCP = rootPath("server", "mcp", "browser-mcp.mjs");

export const mcpConfigPath = (ws: string) => path.join(MCP_DIR, `${ws}.json`);
/** Claude Code settings Crux adds (`--settings`): hooks that tell Crux when a turn ends. */
export const HOOKS_PATH = path.join(home, "claude-hooks.json");

// UserPromptSubmit / PostToolUse = Claude is working; Stop = it finished its
// turn; Notification = it needs your input or permission. PreToolUse ("pre"),
// PostToolUseFailure ("fail") and SessionStart ("session") only feed the Flow
// view (activity.ts). The hook's own JSON (prompt, tool, message, transcript)
// is passed on as the body: see hookDetail. CRUX_TOKEN proves the terminal.
const report = (event: string) =>
  `[ -n "$CRUX_TERM" ] && curl -s -m 2 -X POST -H 'Content-Type: application/json' -H "X-Crux-Token: $CRUX_TOKEN" ` +
  `--data-binary @- "$CRUX_URL/api/agent-event?term=$CRUX_TERM&event=${event}" >/dev/null 2>&1; true`;

/** Hook events only the Flow view uses (no status pill). */
export const FLOW_EVENTS = ["pre", "fail", "session"];

// Per-terminal secret for /api/agent-event, so other local processes can't post as a terminal.
const tokens = new Map<string, string>();

/** False when the terminal has a token and `token` isn't it (terminals without one: anything goes). */
export function termTokenOk(term: string, token: string): boolean {
  const want = tokens.get(term);
  return !want || want === token;
}

export const dropTermToken = (term: string) => void tokens.delete(term);

// Older claude CLIs reject --settings: then chats start without the hooks.
let hooksSupported = true;
execFile("claude", ["--help"], { timeout: 15000 }, (err, out) => {
  if (!err) hooksSupported = /--settings\b/.test(out);
});

function writeHooks(): void {
  const hook = (event: string) => [{ hooks: [{ type: "command", command: report(event) }] }];
  const cfg = {
    hooks: {
      UserPromptSubmit: hook("working"),
      PostToolUse: hook("working"),
      Stop: hook("stop"),
      Notification: hook("input"),
      PreToolUse: hook("pre"),
      PostToolUseFailure: hook("fail"),
      SessionStart: hook("session"),
    },
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

/** Claude's whole last reply (Stop hook), for an orchestrator lead to read. */
export function fullReply(hook: Record<string, unknown>): string {
  const msg = typeof hook.last_assistant_message === "string" ? hook.last_assistant_message : "";
  const transcript = typeof hook.transcript_path === "string" ? hook.transcript_path : "";
  return msg || (transcript && lastReply(transcript));
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
# claude / codex in a Crux terminal: Crux's hooks (finished / needs input) and,
# where the in-app browser exists (macOS), the crux-browser tools.
if [[ -n "$CRUX_TERM" ]]; then
  claude() {
    case "$1" in
      mcp|config|update|doctor|install|setup-token|migrate-installer|plugin|plugins|auth|-v|--version|-h|--help)
        command claude "$@" ;;
      *)
        local extra=()
        [[ -n "$CRUX_MCP_CONFIG" && -f "$CRUX_MCP_CONFIG" ]] && extra+=(--mcp-config "$CRUX_MCP_CONFIG")
        [[ -f "$CRUX_HOOKS" ]] && extra+=(--settings "$CRUX_HOOKS")
        command claude "\${extra[@]}" "$@" ;;
    esac
  }
fi
if [[ -n "$CRUX_MCP_CONFIG" && -f "$CRUX_MCP_CONFIG" ]]; then
  codex() {
    command codex \\
      -c "mcp_servers.crux_browser.command=\\"$QL_NODE\\"" \\
      -c "mcp_servers.crux_browser.args=[\\"$QL_BROWSER_MCP\\"]" \\
      -c "mcp_servers.crux_browser.env={CRUX_WORKSPACE=\\"$CRUX_WORKSPACE\\",CRUX_URL=\\"$CRUX_URL\\",CRUX_TERM=\\"$CRUX_TERM\\"}" \\
      "$@"
  }
fi
`;

// POSIX sh: run the real claude / codex (the next one on PATH after ours)
// with Crux's hooks and, on macOS, the crux-browser tools.
const binWrapper = (name: "claude" | "codex") => `#!/bin/sh
# Crux: ${name === "claude" ? "claude with Crux's hooks and, on macOS, its browser tools" : "codex with Crux's browser tools on macOS"}. Made by Crux; rewritten on start.
here=$(cd "$(dirname "$0")" && pwd)
real=$(PATH=$(printf %s "$PATH" | tr ':' '\n' | grep -vx "$here" | paste -sd: -) command -v ${name})
[ -n "$real" ] || { echo "${name}: not found on PATH" >&2; exit 127; }
${
  name === "claude"
    ? `case "$1" in
  mcp|config|update|doctor|install|setup-token|migrate-installer|plugin|plugins|auth|-v|--version|-h|--help) exec "$real" "$@" ;;
esac
[ -f "$CRUX_HOOKS" ] && set -- --settings "$CRUX_HOOKS" "$@"
[ -n "$CRUX_MCP_CONFIG" ] && [ -f "$CRUX_MCP_CONFIG" ] && set -- --mcp-config "$CRUX_MCP_CONFIG" "$@"`
    : `[ -n "$CRUX_MCP_CONFIG" ] && [ -f "$CRUX_MCP_CONFIG" ] && set -- \\
  -c "mcp_servers.crux_browser.command=\\"$QL_NODE\\"" \\
  -c "mcp_servers.crux_browser.args=[\\"$QL_BROWSER_MCP\\"]" \\
  -c "mcp_servers.crux_browser.env={CRUX_WORKSPACE=\\"$CRUX_WORKSPACE\\",CRUX_URL=\\"$CRUX_URL\\",CRUX_TERM=\\"$CRUX_TERM\\"}" \\
  "$@"`
}
exec "$real" "$@"
`;

// Windows (PowerShell / cmd): claude.cmd runs the real claude (the next one
// on PATH after ours) with Crux's hooks, and an orchestrator lead's tools. No
// browser tools there, so no codex one.
const CLAUDE_CMD = `@echo off
rem Crux: claude with Crux's hooks. Made by Crux; rewritten on start.
setlocal
set "REAL="
for /f "delims=" %%i in ('where claude 2^>nul') do (
  if /i not "%%~dpi"=="%~dp0" if not defined REAL set "REAL=%%i"
)
if not defined REAL (
  echo claude: not found on PATH 1>&2
  exit /b 127
)
for %%a in (mcp config update doctor install setup-token migrate-installer plugin plugins auth -v --version -h --help) do (
  if /i "%~1"=="%%a" goto plain
)
set "EXTRA="
if defined CRUX_MCP_CONFIG if exist "%CRUX_MCP_CONFIG%" set EXTRA=--mcp-config "%CRUX_MCP_CONFIG%"
if exist "%CRUX_HOOKS%" (
  "%REAL%" --settings "%CRUX_HOOKS%" %EXTRA% %*
  exit /b
)
"%REAL%" %EXTRA% %*
exit /b
:plain
"%REAL%" %*
`;

export function installAgentSetup(): void {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(BIN_DIR, "claude.cmd"), CLAUDE_CMD.replace(/\n/g, "\r\n"));
  } else {
    for (const name of ["claude", "codex"] as const) {
      const file = path.join(BIN_DIR, name);
      fs.writeFileSync(file, binWrapper(name));
      fs.chmodSync(file, 0o755);
    }
  }
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
  const token = crypto.randomBytes(16).toString("hex");
  tokens.set(term, token);
  const env: Record<string, string> = {
    CRUX_WORKSPACE: ws,
    CRUX_TERM: term,
    CRUX_TOKEN: token,
    CRUX_HOOKS: hooksSupported ? HOOKS_PATH : "",
    CRUX_URL: SERVER_URL,
    // No in-app browser off macOS: agents get no crux-browser tools there.
    // An orchestrator lead gets its own config with the crux-agents tools.
    CRUX_MCP_CONFIG: leadMcpConfig(term) || (BROWSER_SUPPORTED ? mcpConfigPath(ws) : ""),
    QL_NODE: process.execPath,
    QL_BROWSER_MCP: BROWSER_MCP,
  };
  if (path.basename(shell) === "zsh") {
    // Crux started from a Crux terminal (e.g. a dev copy) inherits that
    // terminal's ZDOTDIR: Crux's own forwarding files, which would then
    // forward to themselves forever. Use the user's real one behind it.
    const inherited = process.env.ZDOTDIR;
    const ours = !!inherited && fs.existsSync(path.join(inherited, ".zshrc")) && fs.readFileSync(path.join(inherited, ".zshrc"), "utf8").startsWith("# Crux shell integration");
    env.QL_USER_ZDOTDIR = (ours ? process.env.QL_USER_ZDOTDIR : inherited) || os.homedir();
    env.ZDOTDIR = ZSH_DIR;
  } else {
    // bash, fish, PowerShell, …: the wrappers in ~/.crux/bin come first on PATH.
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = `${BIN_DIR}${path.delimiter}${process.env[key] ?? ""}`;
  }
  return env;
}
