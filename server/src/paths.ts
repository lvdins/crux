import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where Crux's own files live. In development that's the repo root;
 * in the packaged app the desktop shell sets CRUX_ROOT to the bundled
 * resources folder, which mirrors the repo layout.
 */
export const ROOT = process.env.CRUX_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PACKAGED = !!process.env.CRUX_ROOT;

export const rootPath = (...parts: string[]) => path.join(ROOT, ...parts);

/** Per-user data folder. `npm run app:dev` points this at ~/.crux-dev so a
 *  development copy never touches the installed app's settings. */
export const DEFAULT_HOME = path.join(os.homedir(), ".crux");
export const CRUX_HOME = process.env.CRUX_HOME || DEFAULT_HOME;
/** Server port (installed app 8787, dev 8788). */
export const PORT = Number(process.env.CRUX_PORT) || 8787;
export const SERVER_URL = `http://127.0.0.1:${PORT}`;

/**
 * Apps launched from Finder get a bare PATH (/usr/bin:/bin:…), so git, uv,
 * claude and codex would be "missing". Ask the user's login shell for the
 * PATH it really uses.
 */
export function adoptLoginShellPath(): void {
  // Windows apps get the user's full PATH already.
  if (process.platform === "win32") return;
  if (process.env.PATH?.includes("/opt/homebrew/bin") || process.env.PATH?.includes("/usr/local/bin")) return;
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  try {
    const out = execFileSync(shell, ["-ilc", 'printf "\\n__QLPATH__%s\\n" "$PATH"'], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n").find((l) => l.startsWith("__QLPATH__"));
    const found = line?.slice("__QLPATH__".length).trim();
    if (found) process.env.PATH = found;
  } catch {
    // Keep the bare PATH plus the usual install locations.
    process.env.PATH = ["/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME}/.local/bin`, process.env.PATH].join(":");
  }
}

/** Install command for this OS: Homebrew on macOS, apt on Linux, winget on Windows. */
export const installFor = (mac: string, linux: string, win: string) =>
  process.platform === "darwin" ? mac : process.platform === "win32" ? win : linux;

export interface ToolStatus {
  name: string;
  path: string | null;
  version: string | null;
  needed: string;
  install: string;
}

const TOOLS: Omit<ToolStatus, "path" | "version">[] = [
  { name: "git", needed: "Branch names, cloning repos", install: installFor("xcode-select --install", "sudo apt install -y git", "winget install Git.Git") },
  { name: "claude", needed: "Claude button and agent terminals", install: "npm install -g @anthropic-ai/claude-code" },
  { name: "codex", needed: "Codex button", install: "npm install -g @openai/codex" },
  { name: "uv", needed: "Docs preview (MkDocs)", install: installFor("brew install uv", "curl -LsSf https://astral.sh/uv/install.sh | sh", "winget install astral-sh.uv") },
  { name: "node", needed: "Running Playwright tests", install: installFor("brew install node", "sudo apt install -y nodejs npm", "winget install OpenJS.NodeJS.LTS") },
];

export function checkTools(): ToolStatus[] {
  return TOOLS.map((t) => {
    let found: string | null = null;
    let version: string | null = null;
    try {
      const which = process.platform === "win32" ? "where" : "/usr/bin/which";
      found = execFileSync(which, [t.name], { encoding: "utf8", timeout: 3000 }).split(/\r?\n/)[0].trim() || null;
    } catch {
      found = null;
    }
    if (found) {
      try {
        version = execFileSync(found, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
          .trim()
          .split("\n")[0]
          .slice(0, 60);
      } catch {
        version = null;
      }
    }
    return { ...t, path: found, version };
  });
}
