import { execFile } from "node:child_process";
import { config } from "./config.js";
import { parseRemote } from "./pipelines.js";
import { installFor } from "./paths.js";

/**
 * Settings → Setup: is each tool Crux leans on installed and logged in?
 * Each problem comes with the command that fixes it, which Crux can run in
 * a terminal for you.
 */

export interface ToolHealth {
  name: string;
  /** What breaks without it. */
  needed: string;
  /** Problems here show a dot on the Settings gear. */
  required: boolean;
  path: string | null;
  version: string | null;
  /** null = no login to check. */
  login: null | { ok: boolean; detail: string };
  /** Command that fixes the problem (install or log in). */
  fix: string | null;
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(cmd, args, { timeout: 12000, env }, (err, out, errOut) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${out}\n${errOut}`.trim() }),
    ),
  );

const where = async (name: string) => {
  const r = await run(process.platform === "win32" ? "where" : "/usr/bin/which", [name]);
  return r.code === 0 ? r.out.split(/\r?\n/)[0].trim() : null;
};

/** GitLab hosts of the E2E / API workspaces (pipelines need glab there). */
async function gitlabHosts(): Promise<string[]> {
  const hosts = new Set<string>();
  for (const repo of Object.values(config.repos)) {
    if (repo.kind !== "playwright" && repo.kind !== "pytest") continue;
    const r = await run("git", ["-C", repo.path, "remote", "get-url", "origin"]);
    const remote = r.code === 0 ? parseRemote(r.out) : null;
    if (!remote) continue;
    const host = remote.host.toLowerCase();
    // Bitbucket Cloud (including its alternate SSH host) cannot use glab.
    // Preserve custom hosts for self-managed GitLab installations.
    if (!host.includes("github") && host !== "bitbucket.org" && !host.endsWith(".bitbucket.org")) hosts.add(remote.host);
  }
  return [...hosts];
}

async function check(
  name: string,
  needed: string,
  required: boolean,
  install: string,
  login?: () => Promise<{ ok: boolean; detail: string; fix: string }>,
): Promise<ToolHealth> {
  const path = await where(name);
  if (!path) return { name, needed, required, path, version: null, login: null, fix: install };
  const v = await run(path, ["--version"]);
  const version = v.code === 0 ? v.out.split("\n")[0].slice(0, 60) : null;
  if (!login) return { name, needed, required, path, version, login: null, fix: null };
  const l = await login();
  return { name, needed, required, path, version, login: { ok: l.ok, detail: l.detail }, fix: l.ok ? null : l.fix };
}


export async function checkSetup(): Promise<ToolHealth[]> {
  const hosts = await gitlabHosts();
  return Promise.all([
    check("git", "Branches, cloning repos", true, installFor("xcode-select --install", "sudo apt install -y git", "winget install Git.Git")),
    check("claude", "Claude chats", true, "npm install -g @anthropic-ai/claude-code", async () => {
      const r = await run("claude", ["auth", "status"]);
      // Older CLIs have no `auth status`: don't call that logged out.
      if (r.code !== 0 && /unknown command|unknown option|error: unknown/i.test(r.out)) return { ok: true, detail: "Installed (update to check login)", fix: "" };
      const ok = r.code === 0 && /"loggedIn":\s*true/.test(r.out);
      return { ok, detail: ok ? "Logged in" : "Not logged in", fix: "claude auth login" };
    }),
    check("codex", "Codex chats", false, "npm install -g @openai/codex", async () => {
      const r = await run("codex", ["login", "status"]);
      const ok = r.code === 0 && /logged in/i.test(r.out);
      return { ok, detail: ok ? r.out.split("\n")[0] : "Not logged in", fix: "codex login" };
    }),
    check("gh", "Crux updates (private GitHub releases)", true, installFor("brew install gh", "sudo apt install -y gh", "winget install GitHub.cli"), async () => {
      const r = await run("gh", ["auth", "status", "--hostname", "github.com"]);
      const user = /account (\S+)/.exec(r.out)?.[1];
      return { ok: r.code === 0, detail: r.code === 0 ? `github.com${user ? ` as ${user}` : ""}` : "Not logged in to github.com", fix: "gh auth login" };
    }),
    check("glab", "Pipelines tab (GitLab)", hosts.length > 0, installFor("brew install glab", "sudo apt install -y glab", "winget install GLab.GLab"), async () => {
      if (!hosts.length) return { ok: true, detail: "No GitLab workspaces", fix: "" };
      // A GITLAB_TOKEN for another host overrides the saved login (see pipelines.ts).
      const { GITLAB_TOKEN: _t, ...noToken } = process.env;
      const bad: string[] = [];
      for (const host of hosts) {
        const r = await run("glab", ["auth", "status", "--hostname", host]);
        if (r.code !== 0 && (await run("glab", ["auth", "status", "--hostname", host], noToken)).code !== 0) bad.push(host);
      }
      return {
        ok: !bad.length,
        detail: bad.length ? `Not logged in to ${bad.join(", ")}` : hosts.join(", "),
        fix: `glab auth login --hostname ${bad[0] ?? hosts[0]}`,
      };
    }),
    check("node", "Running Playwright tests", false, installFor("brew install node", "sudo apt install -y nodejs npm", "winget install OpenJS.NodeJS.LTS")),
    check("uv", "Docs preview (MkDocs)", false, installFor("brew install uv", "curl -LsSf https://astral.sh/uv/install.sh | sh", "winget install astral-sh.uv")),
  ]);
}
