import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where QualityLab's own files live. In development that's the repo root;
 * in the packaged app the desktop shell sets QUALITYLAB_ROOT to the bundled
 * resources folder, which mirrors the repo layout.
 */
export const ROOT = process.env.QUALITYLAB_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PACKAGED = !!process.env.QUALITYLAB_ROOT;

export const rootPath = (...parts: string[]) => path.join(ROOT, ...parts);

/**
 * Apps launched from Finder get a bare PATH (/usr/bin:/bin:…), so git, uv,
 * claude and codex would be "missing". Ask the user's login shell for the
 * PATH it really uses.
 */
export function adoptLoginShellPath(): void {
  if (process.env.PATH?.includes("/opt/homebrew/bin") || process.env.PATH?.includes("/usr/local/bin")) return;
  const shell = process.env.SHELL || "/bin/zsh";
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

export interface ToolStatus {
  name: string;
  path: string | null;
  version: string | null;
  needed: string;
  install: string;
}

const TOOLS: Omit<ToolStatus, "path" | "version">[] = [
  { name: "git", needed: "Branch names, cloning repos", install: "xcode-select --install" },
  { name: "claude", needed: "Claude button and agent terminals", install: "npm install -g @anthropic-ai/claude-code" },
  { name: "codex", needed: "Codex button", install: "npm install -g @openai/codex" },
  { name: "uv", needed: "Docs preview (MkDocs)", install: "brew install uv" },
  { name: "node", needed: "Running Playwright tests", install: "brew install node" },
];

export function checkTools(): ToolStatus[] {
  return TOOLS.map((t) => {
    let found: string | null = null;
    let version: string | null = null;
    try {
      found = execFileSync("/usr/bin/which", [t.name], { encoding: "utf8", timeout: 3000 }).trim() || null;
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
