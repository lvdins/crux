import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_SUPPORTED, config } from "./config.js";
import { BROWSER_MCP } from "./agent-setup.js";
import { CRUX_HOME, SERVER_URL, rootPath } from "./paths.js";

/**
 * Orchestrator mode: one Claude chat (the lead) splits a task across worker
 * agents. The lead gets the crux-agents MCP tools (server/mcp/agents-mcp.mjs),
 * which call the /api/orch routes below. Workers are ordinary Claude / Codex
 * terminals that open as splits in the lead's chat; with git, each works in
 * its own worktree on its own branch, and the lead merges the results.
 */

export type WorkerKind = "claude" | "codex";
export type WorkerStatus = "working" | "input" | "done" | "closed";

export interface Worker {
  id: string;
  name: string;
  kind: WorkerKind;
  task: string;
  status: WorkerStatus;
  /** Claude's last full reply (Stop hook), for read_agent / wait_for_agents. */
  reply: string;
  /** Latest one-line detail from the hooks. */
  detail: string;
  cwd: string;
  branch?: string;
  startedAt: number;
}

export interface Team {
  lead: string;
  ws: string;
  chat: string;
  /** Most workers running at once. */
  max: number;
  kind: WorkerKind | "mix";
  /** Claude model alias for the lead and Claude workers ("" = your Claude default). */
  model?: string;
  /** Codex model for Codex workers ("" = your Codex default). */
  codexModel?: string;
  approve: boolean;
  token: string;
  workers: Worker[];
  /** Short id used in branch and worktree names. */
  tag: string;
}

/** What a terminal gets when the server first starts it (see term.ts). */
export interface BootPlan {
  cwd?: string;
  env: Record<string, string>;
  /** Appended to the boot command (refers to the env above, never inlined). */
  append: string;
}

const FILE = path.join(CRUX_HOME, "teams.json");
const MCP_DIR = path.join(CRUX_HOME, "mcp");
export const AGENTS_MCP = rootPath("server", "mcp", "agents-mcp.mjs");
const WIN = process.platform === "win32";

const teams = new Map<string, Team>();
/** First boot of a lead or worker: its brief and task (used once). */
const boots = new Map<string, BootPlan>();

try {
  for (const t of JSON.parse(fs.readFileSync(FILE, "utf8")) as Team[]) teams.set(t.lead, t);
} catch {
  /* none yet */
}
const save = () => {
  try {
    fs.writeFileSync(FILE, JSON.stringify([...teams.values()], null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* read-only home: teams just aren't remembered */
  }
};

let broadcast: (msg: unknown) => boolean = () => false;
let startTerm: (id: string, ws: string, bootCmd: string) => void = () => {};
let writeTerm: (id: string, data: string) => void = () => {};
let stopTerm: (id: string) => void = () => {};
let tailOf: (id: string) => { text: string; quietMs: number; alive: boolean } = () => ({ text: "", quietMs: Infinity, alive: false });

/** index.ts wires in the terminal and window plumbing (avoids an import cycle). */
export function initOrchestrator(deps: {
  broadcast: (msg: unknown) => boolean;
  startTerm: typeof startTerm;
  writeTerm: typeof writeTerm;
  stopTerm: typeof stopTerm;
  tailOf: typeof tailOf;
}) {
  ({ broadcast, startTerm, writeTerm, stopTerm, tailOf } = deps);
}

const envRef = (name: string) => (WIN ? `$env:${name}` : `"$${name}"`);
const leadMcpPath = (lead: string) => path.join(MCP_DIR, `lead-${lead.replace(/[^\w-]/g, "_")}.json`);

export const teamOf = (lead: string) => teams.get(lead);
export const isLead = (term: string) => teams.has(term);
export const leadMcpConfig = (term: string) => (teams.has(term) ? leadMcpPath(term) : "");
const workerOf = (term: string) => {
  for (const t of teams.values()) {
    const w = t.workers.find((x) => x.id === term);
    if (w) return { team: t, worker: w };
  }
  return null;
};
/** A worker's worktree: it reopens there after Crux restarts, too. */
export const cwdFor = (term: string) => workerOf(term)?.worker.cwd;

function writeLeadMcp(team: Team) {
  fs.mkdirSync(MCP_DIR, { recursive: true });
  const servers: Record<string, unknown> = {
    "crux-agents": {
      type: "stdio",
      command: process.execPath,
      args: [AGENTS_MCP],
      env: { CRUX_LEAD: team.lead, CRUX_TEAM_TOKEN: team.token, CRUX_URL: SERVER_URL },
    },
  };
  if (BROWSER_SUPPORTED) {
    servers["crux-browser"] = {
      type: "stdio",
      command: process.execPath,
      args: [BROWSER_MCP],
      env: { CRUX_WORKSPACE: team.ws, CRUX_URL: SERVER_URL },
    };
  }
  fs.writeFileSync(leadMcpPath(team.lead), JSON.stringify({ mcpServers: servers }, null, 2) + "\n", { mode: 0o600 });
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const isGit = (dir: string) => {
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
};

const leadBrief = (team: Team, repo: string, gitRepo: boolean) =>
  [
    "You are the lead of a Crux orchestrator team. The user gives you one task; you split it across worker agents, steer them, and deliver the combined result.",
    `The user asked for ${team.max} worker agent${team.max === 1 ? "" : "s"}. Start them with the crux-agents spawn_agent tool: they open as panes next to you that the user can watch and type into. Don't use your built-in Task/Agent subagents for the parts; the workers are the team. Never run more than ${team.max} at once.`,
    team.kind === "mix" ? "Workers can be Claude or Codex: choose per part." : `Workers are ${team.kind === "claude" ? "Claude" : "Codex"} agents.`,
    "How to work:",
    `1. Look at the code briefly (a few minutes at most): just enough to split the task. Split it into ${team.max} independent part${team.max === 1 ? "" : "s"} (fewer only if it truly can't be split; say why). Research and exploration tasks split by area too: each worker investigates one area and reports back.`,
    team.approve
      ? "2. Show the plan (one line per worker: name, what it does) and wait for the user's OK before starting any worker."
      : "2. Show the plan in one line per worker, then start the workers right away.",
    "3. spawn_agent once per part. Give each worker a complete, self-contained task: goal, files involved, constraints, how to verify, and what to report back. Workers don't see this conversation.",
    "4. wait_for_agents, then read each result. Answer a worker's question with send_to_agent; ask the user only when you can't. A worker showing a folder-trust or permission prompt is waiting for the user: tell them which pane needs them.",
    gitRepo
      ? `5. Each worker works in its own git worktree on its own branch (shown by spawn_agent) and commits there. When a worker is done, check its branch (git log / git diff), merge it into the current branch in ${repo}, fix conflicts, and run the checks. Then stop_agent with remove_worktree=true.`
      : `5. This folder is not a git repository, so all workers share ${repo}: give them non-overlapping files. Check the combined result when they are done, then stop_agent.`,
    "6. Finish with a short summary for the user: what changed, what was verified, anything left open.",
  ].join("\n");

const workerBrief = (team: Team, w: Worker, repo: string) =>
  [
    `You are worker "${w.name}" in a Crux orchestrator team; a lead agent gave you this task and will read your final message.`,
    w.branch
      ? `You work in your own git worktree (${w.cwd}) on branch ${w.branch}, separate from the main checkout (${repo}). Dependencies such as node_modules may be missing here: install them if you need to run things. Commit your work on this branch when done; don't merge or push.`
      : `You share ${repo} with other workers: only change the files your task is about.`,
    "Stay within your task. If something blocks you, say so plainly instead of guessing.",
    "End with a short report: what you changed (files), how you verified it, anything unfinished.",
  ].join("\n");

/** The Orchestrate dialog: registers the lead before its terminal opens. */
export function startTeam(opts: { ws: string; chat: string; lead: string; max: number; kind: string; model: string; codexModel: string; approve: boolean; task: string }) {
  const repo = config.repos[opts.ws];
  if (!repo || !opts.lead || !opts.task.trim()) throw new Error("Bad team");
  const team: Team = {
    lead: opts.lead,
    ws: opts.ws,
    chat: opts.chat,
    max: Math.min(Math.max(opts.max | 0, 1), 5),
    kind: opts.kind === "codex" || opts.kind === "claude" ? opts.kind : "mix",
    model: /^[\w.-]{1,40}$/.test(opts.model) && opts.model !== "default" ? opts.model : "",
    codexModel: /^[\w.-]{1,60}$/.test(opts.codexModel) && opts.codexModel !== "default" ? opts.codexModel : "",
    approve: opts.approve,
    token: crypto.randomBytes(18).toString("hex"),
    workers: [],
    tag: crypto.randomBytes(3).toString("hex"),
  };
  teams.set(team.lead, team);
  save();
  writeLeadMcp(team);
  boots.set(team.lead, {
    env: { CRUX_BRIEF: leadBrief(team, repo.path, isGit(repo.path)), CRUX_TASK: opts.task.trim() },
    append: `${team.model ? ` --model ${team.model}` : ""} --append-system-prompt ${envRef("CRUX_BRIEF")} ${envRef("CRUX_TASK")}`,
  });
  publish(team);
}

/** Taken by term.ts when it first starts this terminal. */
export function takeBoot(term: string): BootPlan | undefined {
  const plan = boots.get(term);
  boots.delete(term);
  return plan;
}

/** Hook events (agent-event route) for worker terminals. */
export function noteWorkerEvent(term: string, event: string, detail: string, reply: string) {
  const found = workerOf(term);
  if (!found) return false;
  const { team, worker } = found;
  if (detail) worker.detail = detail;
  if (event === "working") worker.status = "working";
  else if (event === "input") worker.status = "input";
  else {
    worker.status = "done";
    if (reply) worker.reply = reply;
  }
  save();
  publish(team);
  return true;
}

/** A terminal was closed by the user. */
export function noteTermClosed(term: string) {
  if (teams.delete(term)) {
    boots.delete(term);
    fs.rmSync(leadMcpPath(term), { force: true });
    save();
    broadcast({ type: "orch:team", chat: null, lead: term, workers: [] });
    return;
  }
  const found = workerOf(term);
  if (found) {
    found.worker.status = "closed";
    save();
    publish(found.team);
  }
}

/** Status as the lead and the window see it (Codex has no hooks: output decides). */
function liveStatus(w: Worker): WorkerStatus {
  if (w.status === "closed") return w.status;
  const t = tailOf(w.id);
  if (!t.alive) return "closed";
  if (w.kind === "codex") return t.quietMs < 8000 ? "working" : "done";
  // Claude: hooks, plus a backstop for Esc-interrupted turns (no Stop hook).
  if (w.status === "working" && t.quietMs > 30_000) return "done";
  return w.status;
}

function publish(team: Team) {
  broadcast({
    type: "orch:team",
    chat: team.chat,
    lead: team.lead,
    max: team.max,
    workers: team.workers.map((w) => ({ id: w.id, name: w.name, kind: w.kind, status: liveStatus(w), detail: w.detail })),
  });
}

/** Codex's own model list (its cache of what your account offers), best first. */
export function codexModels(): { id: string; label: string }[] {
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
    const models = JSON.parse(fs.readFileSync(file, "utf8")).models as { slug: string; display_name?: string; visibility?: string; priority?: number }[];
    return models
      .filter((m) => m.visibility === "list" && /^[\w.-]{1,60}$/.test(m.slug))
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
  } catch {
    return [];
  }
}

/** Every team, for windows that (re)connect. */
export function allTeams() {
  for (const t of teams.values()) publish(t);
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][\w]|\x1b[=>78]|\r/g;
const plain = (s: string) =>
  s
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l, i, all) => l || all[i - 1])
    .join("\n");

function describe(w: Worker, full = false) {
  const status = liveStatus(w);
  const head = `${w.name} (${w.kind}) — ${status}${w.branch ? ` · branch ${w.branch} · worktree ${w.cwd}` : ""}`;
  if (!full) return w.detail ? `${head}\n  latest: ${w.detail}` : head;
  const body = w.reply || plain(tailOf(w.id).text).slice(-4000);
  return `${head}\n--- ${w.reply ? "final message" : "end of its terminal"} ---\n${body || "(nothing yet)"}`;
}

// --- Tools (agents-mcp.mjs → /api/orch/:lead/:tool) --------------------------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "worker";

function find(team: Team, name: unknown) {
  const w = team.workers.find((x) => x.name === String(name ?? "") || x.id === String(name ?? ""));
  if (!w) throw new Error(`No agent named "${name}". Agents: ${team.workers.map((x) => x.name).join(", ") || "none yet"}`);
  return w;
}

function spawn(team: Team, args: Record<string, unknown>) {
  const repo = config.repos[team.ws];
  if (!repo) throw new Error("This workspace was removed from Crux.");
  const task = String(args.task ?? "").trim();
  if (!task) throw new Error("task is required");
  const kind: WorkerKind = team.kind === "mix" ? (args.kind === "codex" ? "codex" : "claude") : team.kind;
  const running = team.workers.filter((w) => liveStatus(w) !== "closed").length;
  if (running >= team.max) {
    throw new Error(`The user allowed ${team.max} workers at once and ${running} are open. Stop one (stop_agent) or give the work to an existing one (send_to_agent).`);
  }
  let name = slug(String(args.name ?? ""));
  for (let n = 2; team.workers.some((w) => w.name === name); n++) name = `${slug(String(args.name ?? ""))}-${n}`;

  let cwd = repo.path;
  let branch: string | undefined;
  if (args.isolated !== false && isGit(repo.path)) {
    branch = `crux/${team.tag}-${name}`;
    cwd = path.join(CRUX_HOME, "worktrees", team.ws, `${team.tag}-${name}`);
    fs.mkdirSync(path.dirname(cwd), { recursive: true });
    try {
      git(repo.path, ["worktree", "add", "-b", branch, cwd, "HEAD"]);
    } catch (err) {
      throw new Error(`git worktree add failed: ${String((err as { stderr?: string }).stderr || err).trim()}`);
    }
  }

  const id = `${team.chat}:w${team.workers.length + 1}:${Date.now() % 100000}`;
  const w: Worker = { id, name, kind, task, status: "working", reply: "", detail: "", cwd, branch, startedAt: Date.now() };
  const brief = workerBrief(team, w, repo.path);
  // Claude takes the brief as its system prompt; Codex gets it ahead of the task.
  const bootCmd = kind === "claude" ? `claude --session-id ${crypto.randomUUID()}` : "codex";
  boots.set(id, {
    cwd,
    env: kind === "claude" ? { CRUX_BRIEF: brief, CRUX_TASK: task } : { CRUX_TASK: `${brief}\n\nYour task:\n${task}` },
    append:
      kind === "claude"
        ? `${team.model ? ` --model ${team.model}` : ""}${branch ? " --permission-mode acceptEdits" : ""} --append-system-prompt ${envRef("CRUX_BRIEF")} ${envRef("CRUX_TASK")}`
        : `${team.codexModel ? ` -m ${team.codexModel}` : ""} ${envRef("CRUX_TASK")}`,
  });
  team.workers.push(w);
  save();
  startTerm(id, team.ws, bootCmd);
  broadcast({ type: "orch:spawn", chat: team.chat, lead: team.lead, id, name, kind, bootCmd });
  publish(team);
  return `Started ${name} (${kind}).${branch ? ` It works on branch ${branch} in ${cwd}.` : " It works in the main folder."} Use wait_for_agents to wait for it.`;
}

/** Paste text into an agent's prompt and submit it. */
function sendTo(id: string, text: string) {
  writeTerm(id, `\x1b[200~${text}\x1b[201~`);
  setTimeout(() => writeTerm(id, "\r"), 250);
}

async function waitFor(team: Team, args: Record<string, unknown>) {
  const names = Array.isArray(args.agents) && args.agents.length ? args.agents.map(String) : null;
  const list = names ? names.map((n) => find(team, n)) : team.workers.filter((w) => w.status !== "closed");
  if (!list.length) return "No workers are running.";
  const any = args.until === "any";
  const timeout = Math.min(Math.max(Number(args.timeout_seconds) || 300, 5), 600) * 1000;
  const start = Date.now();
  // Codex has no "finished" event: give it time to start before quiet counts.
  const settled = (w: Worker) => liveStatus(w) !== "working" && Date.now() - w.startedAt > 15_000;
  while (Date.now() - start < timeout) {
    const done = list.filter(settled);
    if (any ? done.length > 0 : done.length === list.length) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const waited = Math.round((Date.now() - start) / 1000);
  const finished = list.filter(settled);
  const still = list.filter((w) => !settled(w));
  return [
    still.length ? `Waited ${waited}s; ${still.length} still working: ${still.map((w) => w.name).join(", ")}. Call wait_for_agents again to keep waiting.` : `All ${list.length} settled after ${waited}s.`,
    ...finished.map((w) => describe(w, true)),
    ...still.map((w) => describe(w)),
  ].join("\n\n");
}

function stop(team: Team, args: Record<string, unknown>) {
  const w = find(team, args.agent);
  stopTerm(w.id);
  w.status = "closed";
  broadcast({ type: "orch:close", chat: team.chat, id: w.id });
  let note = "";
  if (w.branch && args.remove_worktree) {
    const repo = config.repos[team.ws];
    try {
      // No --force: a worktree with uncommitted changes stays.
      git(repo.path, ["worktree", "remove", w.cwd]);
      note = ` Removed its worktree; branch ${w.branch} is kept.`;
    } catch (err) {
      note = ` Kept its worktree: ${String((err as { stderr?: string }).stderr || err).trim()}`;
    }
  }
  save();
  publish(team);
  return `Stopped ${w.name}.${note}`;
}

export async function runTool(lead: string, token: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const team = teams.get(lead);
  if (!team || !token || token.length !== team.token.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(team.token))) {
    throw new Error("This chat is no longer an orchestrator lead.");
  }
  switch (tool) {
    case "spawn_agent":
      return spawn(team, args);
    case "list_agents":
      return team.workers.length ? team.workers.map((w) => describe(w)).join("\n") : `No workers yet (up to ${team.max}).`;
    case "read_agent":
      return describe(find(team, args.agent), true);
    case "send_to_agent": {
      const w = find(team, args.agent);
      if (liveStatus(w) === "closed") throw new Error(`${w.name} is closed.`);
      sendTo(w.id, String(args.message ?? ""));
      w.status = "working";
      w.reply = "";
      w.startedAt = Date.now();
      save();
      publish(team);
      return `Sent to ${w.name}.`;
    }
    case "wait_for_agents":
      return waitFor(team, args);
    case "stop_agent":
      return stop(team, args);
  }
  throw new Error(`Unknown tool ${tool}`);
}

// Codex workers change state without events: refresh what windows show.
setInterval(() => {
  for (const t of teams.values()) if (t.workers.some((w) => w.status !== "closed")) publish(t);
}, 5000).unref();
