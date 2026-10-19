// First: on Windows every child process must start hidden (see winproc.ts).
import "./winproc.js";
import express from "express";
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { BROWSER_SUPPORTED, currentSettings, DEFAULT_CHATS, MODE_PRESETS, PREF_KEYS, SETTING_KEYS, type Settings } from "./config.js";
import { config, saveConfig, userConfigPath, addWorkspace, updateWorkspace, removeWorkspace, detectKind, expandHome } from "./config.js";
import { attachTerm, termInput, termResize, killTerm, detachAll, killAllTerms, openLog, termProcess, termTail } from "./term.js";
import { allTeams, codexModels, initOrchestrator, noteTermClosed, noteWorkerEvent, runTool, startTeam } from "./orchestrator.js";
import { startPreview, stopPreview, stopAllPreviews, previewStatus } from "./preview.js";
import { buildTree, sharedEndpoints } from "./tree.js";
import { fullReply, hookDetail, installAgentSetup } from "./agent-setup.js";
import { latestRelease, installRelease, isNewer } from "./update.js";
import { guardHttp, wsAllowed } from "./security.js";
import { pipelinesFor } from "./pipelines.js";
import { checkSetup } from "./health.js";
import { inboxMrs } from "./inbox.js";
import { pastChats } from "./sessions.js";
import { importCookies, importSites, importSources } from "./browserImport.js";
import { adoptLoginShellPath, checkTools, CRUX_HOME, PACKAGED, PORT, rootPath } from "./paths.js";

adoptLoginShellPath();

let connectionsCache: { at: number; data: unknown } | null = null;
let featuresCache: { at: number; data: unknown } | null = null;
const app = express();

// Only the Crux UI (tauri://, vite dev, its own page) may call the API;
// see security.ts. Runs before body parsing so refused requests cost nothing.
app.use(guardHttp);
app.options("*", (_req, res) => res.sendStatus(204));
// Claude hook events carry the hook's JSON, tool output included: allow more.
const jsonBody = express.json();
const hookBody = express.json({ limit: "50mb" });
app.use((req, res, next) => (req.path === "/api/agent-event" ? hookBody : jsonBody)(req, res, next));

// Serve the built client when it exists, so the desktop app (and plain
// http://localhost:8787) works without vite.
const clientDist = rootPath("client", "dist");
app.use(express.static(clientDist));

app.get("/api/config", (_req, res) => {
  res.json({
    repos: Object.fromEntries(
      Object.entries(config.repos).map(([k, r]) => [k, { label: r.label, kind: r.kind, path: r.path, pinned: !!r.pinned, color: r.color }]),
    ),
    user: os.userInfo().username,
    onboarded: !!config.onboarded,
    userName: config.userName ?? "",
    settings: currentSettings(),
    browserSupported: BROWSER_SUPPORTED,
  });
});

// Scheduled CI runs (morning / evening testers) for the Pipelines tab.
app.get("/api/pipelines/:key", async (req, res) => {
  const repo = config.repos[req.params.key];
  if (!repo) return void res.status(404).json({ error: "Unknown workspace" });
  try {
    res.json(await pipelinesFor(repo.path, req.query.refresh === "1"));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// "New Crux version available" bubble (installed app only).
app.get("/api/update", async (req, res) => {
  const current = String(req.query.current ?? "");
  const latest = PACKAGED && current ? await latestRelease() : null;
  res.json({ latest, available: !!latest && isNewer(latest, current) });
});
app.post("/api/update/install", async (_req, res) => {
  const latest = await latestRelease();
  if (!latest) return void res.status(503).json({ error: "Couldn't reach GitHub (is gh logged in?)" });
  try {
    installRelease(latest);
    res.json({ installing: latest });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Files dropped onto a chat: saved here, and their path is typed into the
// terminal (how Claude Code picks up images dragged into a terminal).
app.post("/api/attachments", express.raw({ type: "*/*", limit: "100mb" }), (req, res) => {
  const raw = path.basename(String(req.query.name ?? "file"));
  const safe = raw.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "file";
  const dir = path.join(CRUX_HOME, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}`);
  fs.writeFileSync(file, req.body as Buffer);
  res.json({ path: file });
});

// Settings: { mode } applies that preset; other keys set single toggles.
app.patch("/api/settings", (req, res) => {
  const body = (req.body ?? {}) as Partial<Settings>;
  let next = currentSettings();
  if (body.mode === "qa" || body.mode === "regular") {
    // A mode resets the tabs and views; personal preferences stay.
    const prefs = Object.fromEntries(PREF_KEYS.map((k) => [k, next[k]]));
    next = { ...MODE_PRESETS[body.mode], ...prefs, defaultChat: next.defaultChat, jiraProject: next.jiraProject };
  }
  for (const k of SETTING_KEYS) {
    if (typeof body[k] === "boolean") next[k] = body[k];
  }
  if (DEFAULT_CHATS.includes(body.defaultChat as Settings["defaultChat"])) next.defaultChat = body.defaultChat!;
  if (typeof body.jiraProject === "string" && /^[\w -]{0,40}$/.test(body.jiraProject)) next.jiraProject = body.jiraProject.trim();
  config.settings = next;
  saveConfig();
  res.json(next);
});

app.post("/api/profile", (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 60);
  if (!name) return void res.status(400).json({ error: "Name is required" });
  config.userName = name;
  saveConfig();
  res.json({ userName: name });
});

// Claude Code hooks in Crux terminals report "finished" / "needs input"
// (see agent-setup.ts); every open window gets it to show a notification.
// Older chats post {term, event}; newer hooks put those in the query and the
// hook's own JSON in the body (turned into a one-line detail for the menu bar).
app.post("/api/agent-event", (req, res) => {
  const term = String(req.query.term ?? req.body?.term ?? "");
  const event = String(req.query.event ?? req.body?.event ?? "");
  if (!term || !["stop", "input", "working"].includes(event)) return void res.status(400).json({ error: "Bad event" });
  const detail = req.query.term ? hookDetail(event, req.body ?? {}) : "";
  // Orchestrator workers report to their lead; the team's row shows them.
  if (noteWorkerEvent(term, event, detail, event === "stop" ? fullReply(req.body ?? {}) : "")) return void res.json({ ok: true });
  const msg = JSON.stringify({ type: "agent:event", id: term, event, detail });
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(msg);
  res.json({ ok: true });
});

app.post("/api/onboarded", (req, res) => {
  config.onboarded = req.body?.done !== false;
  saveConfig();
  res.json({ onboarded: config.onboarded });
});

const descriptionsPath = rootPath("crux.descriptions.json");

app.get("/api/tree", async (_req, res) => {
  const trees = buildTree();
  let descriptions: Record<string, Record<string, string>> = {};
  try {
    descriptions = JSON.parse(fs.readFileSync(descriptionsPath, "utf8"));
  } catch {
    // No descriptions file yet — the UI falls back gracefully.
  }
  // Optional folder descriptions (crux.descriptions.json), keyed by
  // workspace; other workspaces fall back by suite type.
  for (const t of trees) {
    if (!descriptions[t.key]) {
      const fallback = descriptions[t.kind === "playwright" ? "e2e" : "api"];
      if (fallback) descriptions[t.key] = fallback;
    }
  }
  res.json({ trees, shared: sharedEndpoints(trees), descriptions });
});

// Settings → Setup: tools installed and logged in.
app.get("/api/health", async (_req, res) => {
  res.json({ tools: await checkSetup() });
});

// Home screen: merge requests waiting for you, or that you opened.
app.get("/api/inbox/mrs", async (req, res) => {
  res.json(await inboxMrs(req.query.refresh === "1"));
});

// Chat search: past Claude / Codex conversations started in a workspace.
// The Sessions view: past Claude / Codex chats of every workspace, newest first.
app.get("/api/history", (req, res) => {
  const q = String(req.query.q ?? "");
  const chats = Object.entries(config.repos)
    .flatMap(([ws, repo]) => pastChats(repo.path, q, q ? 40 : 120).map((c) => ({ ...c, ws })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 500);
  res.json({ chats });
});

app.get("/api/history/:key", (req, res) => {
  const repo = config.repos[req.params.key];
  if (!repo) return void res.status(404).json({ error: "Unknown workspace" });
  res.json({ chats: pastChats(repo.path, String(req.query.q ?? "")) });
});

app.get("/api/system", (_req, res) => {
  res.json({ packaged: PACKAGED, tools: checkTools(), configPath: userConfigPath });
});

app.post("/api/preview/:key/start", (req, res) => {
  startPreview(req.params.key);
  res.json(previewStatus(req.params.key));
});
app.post("/api/preview/:key/stop", (req, res) => {
  stopPreview(req.params.key);
  res.json(previewStatus(req.params.key));
});
app.get("/api/preview/:key/status", (req, res) => {
  res.json(previewStatus(req.params.key));
});

/* ---------- workspaces ---------- */

const invalidate = () => {
  connectionsCache = null;
  featuresCache = null;
};

app.post("/api/workspaces", (req, res) => {
  try {
    const [key, repo] = addWorkspace(req.body ?? {});
    invalidate();
    res.json({ key, repo });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
app.patch("/api/workspaces/:key", (req, res) => {
  try {
    const repo = updateWorkspace(req.params.key, req.body ?? {});
    invalidate();
    res.json({ key: req.params.key, repo });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
app.delete("/api/workspaces/:key", (req, res) => {
  stopPreview(req.params.key);
  removeWorkspace(req.params.key);
  invalidate();
  res.json({ ok: true });
});

app.post("/api/workspaces/:key/reveal", (req, res) => {
  const repo = config.repos[req.params.key];
  if (!repo) return void res.status(404).json({ error: "Unknown workspace" });
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [repo.path], () => {});
  res.json({ ok: true });
});

app.get("/api/workspaces/:key/branch", (req, res) => {
  const repo = config.repos[req.params.key];
  if (!repo) return void res.status(404).json({ error: "Unknown workspace" });
  execFile("git", ["-C", repo.path, "rev-parse", "--abbrev-ref", "HEAD"], (err, stdout) => {
    if (err) return void res.status(400).json({ error: "Not a git repository" });
    res.json({ branch: stdout.trim() });
  });
});

app.get("/api/workspaces/:key/branches", (req, res) => {
  const repo = config.repos[req.params.key];
  if (!repo) return void res.status(404).json({ error: "Unknown workspace" });
  const fmt = "%(refname:short)\t%(committerdate:relative)";
  execFile(
    "git",
    ["-C", repo.path, "for-each-ref", "--sort=-committerdate", `--format=${fmt}`, "refs/heads", "refs/remotes/origin"],
    { maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => {
      if (err) return void res.status(400).json({ error: "Not a git repository" });
      execFile("git", ["-C", repo.path, "rev-parse", "--abbrev-ref", "HEAD"], (_e, head) => {
        const local: { name: string; when: string }[] = [];
        const remote: { name: string; when: string }[] = [];
        for (const line of stdout.split("\n")) {
          const [ref, when] = line.split("\t");
          if (!ref || ref === "origin/HEAD" || ref === "origin") continue;
          if (ref.startsWith("origin/")) remote.push({ name: ref.slice(7), when });
          else local.push({ name: ref, when });
        }
        const localNames = new Set(local.map((b) => b.name));
        res.json({
          current: head.trim(),
          local: local.slice(0, 200),
          // Remote branches you don't have locally (git switch creates them).
          remote: remote.filter((b) => !localNames.has(b.name)).slice(0, 200),
        });
      });
    },
  );
});

// "Delete" moves the folder to the Trash (recoverable), never rm -rf.
app.post("/api/workspaces/:key/trash", (req, res) => {
  const repo = config.repos[req.params.key];
  if (!repo) return void res.status(404).json({ error: "Unknown workspace" });
  if (process.platform === "win32") {
    // Windows: the Recycle Bin, through .NET (no Trash folder to move into).
    const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CRUX_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    return void execFile("powershell.exe", ["-NoProfile", "-Command", ps], { env: { ...process.env, CRUX_TRASH: repo.path } }, (err) => {
      if (err) return void res.status(400).json({ error: `Could not move to the Recycle Bin: ${err.message}` });
      stopPreview(req.params.key);
      removeWorkspace(req.params.key);
      invalidate();
      res.json({ ok: true });
    });
  }
  const trashDir =
    process.platform === "darwin" ? path.join(os.homedir(), ".Trash") : path.join(os.homedir(), ".local/share/Trash/files");
  try {
    fs.mkdirSync(trashDir, { recursive: true });
    const base = path.basename(repo.path);
    let target = path.join(trashDir, base);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(trashDir, `${base} ${n}`);
    fs.renameSync(repo.path, target);
  } catch (err) {
    return void res.status(400).json({ error: `Could not move to Trash: ${(err as Error).message}` });
  }
  stopPreview(req.params.key);
  removeWorkspace(req.params.key);
  invalidate();
  res.json({ ok: true });
});

// Folder browser for the "add workspace" dialog — works the same in the
// browser and in the desktop shell, no native dialog plugin needed.
app.get("/api/fs/list", (req, res) => {
  const raw = typeof req.query.path === "string" && req.query.path ? req.query.path : os.homedir();
  const dir = path.resolve(expandHome(raw));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    res.status(400).json({ error: `Cannot open ${dir}` });
    return;
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 400)
    .map((name) => {
      const kind = detectKind(path.join(dir, name));
      return { name, kind: kind === "generic" ? undefined : kind };
    });
  const kind = detectKind(dir);
  res.json({ path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), home: os.homedir(), kind, dirs });
});

/** New folder inside `parent` (Add workspace → New folder). */
app.post("/api/fs/mkdir", (req, res) => {
  const { parent, name } = req.body ?? {};
  const clean = typeof name === "string" ? name.trim() : "";
  if (typeof parent !== "string" || !parent) {
    res.status(400).json({ error: "Missing parent folder" });
    return;
  }
  if (!clean || clean === "." || clean === ".." || /[/\\\0]/.test(clean)) {
    res.status(400).json({ error: "Folder name can't be empty or contain slashes" });
    return;
  }
  const dir = path.join(path.resolve(expandHome(parent)), clean);
  if (fs.existsSync(dir)) {
    res.status(409).json({ error: `${clean} already exists` });
    return;
  }
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    res.status(400).json({ error: `Cannot create ${dir}: ${(err as Error).message}` });
    return;
  }
  res.json({ path: dir });
});

app.get("/api/term/:id/process", (req, res) => {
  res.json({ process: termProcess(req.params.id) });
});

app.get("/api/debug/opens", (_req, res) => {
  res.json(openLog);
});

app.get("/api/features", async (req, res) => {
  // Scanning the dashboard + backend + both suites takes a second or two.
  if (!featuresCache || req.query.refresh || Date.now() - featuresCache.at > 5 * 60_000) {
    const { buildFeatureMap } = await import("./features.js");
    featuresCache = { at: Date.now(), data: buildFeatureMap() };
  }
  res.json(featuresCache.data);
});

// Connections → Graph: how dashboard features connect (code + shared backend data).
let featureGraphCache: { at: number; data: unknown } | null = null;
app.get("/api/feature-graph", async (req, res) => {
  if (!featureGraphCache || req.query.refresh || Date.now() - featureGraphCache.at > 5 * 60_000) {
    const { buildFeatureGraph } = await import("./featureLinks.js");
    featureGraphCache = { at: Date.now(), data: buildFeatureGraph() };
  }
  res.json(featureGraphCache.data);
});

app.get("/api/connections", async (_req, res) => {
  // Reading every test file is a few hundred ms — cache for a minute.
  if (!connectionsCache || Date.now() - connectionsCache.at > 60_000) {
    const { buildConnections } = await import("./links.js");
    connectionsCache = { at: Date.now(), data: buildConnections() };
  }
  res.json(connectionsCache.data);
});

/* ---------- agent browser bridge ----------
 * MCP tool → POST here → the desktop UI (which owns the native browser
 * panes) runs it → result comes back over the same WebSocket. */
const browserHosts = new Set<WebSocket>();
const pendingBrowser = new Map<string, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();
let browserSeq = 0;

app.post("/api/agent-browser/:ws", async (req, res) => {
  const ws = req.params.ws;
  if (!config.repos[ws]) return void res.status(404).json({ ok: false, error: `Unknown workspace "${ws}"` });
  const host = [...browserHosts].pop();
  if (!host || host.readyState !== WebSocket.OPEN) {
    return void res.status(503).json({ ok: false, error: "The Crux desktop app isn't open — the browser lives in its window." });
  }
  const id = `b${++browserSeq}`;
  const result = await new Promise<any>((resolve) => {
    const timer = setTimeout(() => {
      pendingBrowser.delete(id);
      resolve({ ok: false, error: "Timed out waiting for the browser (60s)" });
    }, 60_000);
    pendingBrowser.set(id, { resolve, timer });
    host.send(JSON.stringify({ type: "browser:cmd", id, ws, op: req.body?.op, args: req.body?.args ?? {} }));
  });
  res.status(result.ok ? 200 : 400).json(result);
});

app.get("/api/codex-models", (_req, res) => res.json(codexModels()));

// Import logins from Arc / Chrome (see browserImport.ts). Decrypted cookies
// only go to the Crux window: requests must carry its Origin, so other local
// programs (which send none) can't fetch them.
const fromUi = (req: express.Request, res: express.Response) => {
  if (req.headers.origin) return true;
  res.status(403).json({ error: "Only the Crux window can import logins" });
  return false;
};
app.get("/api/browser-import/sources", (req, res) => {
  if (fromUi(req, res)) res.json(importSources());
});
app.get("/api/browser-import/sites", async (req, res) => {
  if (!fromUi(req, res)) return;
  try {
    res.json(await importSites(String(req.query.browser ?? ""), String(req.query.profile ?? "")));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
app.post("/api/browser-import/cookies", async (req, res) => {
  if (!fromUi(req, res)) return;
  try {
    const sites = Array.isArray(req.body?.sites) ? req.body.sites.map(String) : [];
    res.json(await importCookies(String(req.body?.browser ?? ""), String(req.body?.profile ?? ""), sites));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Orchestrator mode: the lead's crux-agents MCP tools (see orchestrator.ts).
app.post("/api/orch/:lead/:tool", async (req, res) => {
  try {
    const text = await runTool(req.params.lead, String(req.headers["x-crux-team"] ?? ""), req.params.tool, req.body?.args ?? {});
    res.json({ ok: true, text });
  } catch (err) {
    res.status(400).json({ ok: false, error: String((err as Error)?.message ?? err) });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", verifyClient: (info: { req: http.IncomingMessage }) => wsAllowed(info.req) });

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case "term:open":
          attachTerm(
            String(msg.id),
            String(msg.repo),
            ws,
            msg.cols | 0,
            msg.rows | 0,
            !!msg.fresh,
            typeof msg.bootCmd === "string" ? msg.bootCmd : undefined,
          );
          break;
        case "term:input":
          termInput(String(msg.id), String(msg.data ?? ""));
          break;
        case "term:resize":
          termResize(String(msg.id), msg.cols | 0, msg.rows | 0);
          break;
        case "term:kill":
          killTerm(String(msg.id));
          noteTermClosed(String(msg.id));
          break;
        case "orch:start":
          startTeam({
            ws: String(msg.ws),
            chat: String(msg.chat),
            lead: String(msg.lead),
            max: Number(msg.max),
            kind: String(msg.kind),
            model: String(msg.model ?? ""),
            codexModel: String(msg.codexModel ?? ""),
            approve: msg.approve !== false,
            task: String(msg.task ?? ""),
          });
          break;
        case "orch:hello":
          allTeams();
          break;
        case "browser:host":
          browserHosts.add(ws);
          break;
        case "browser:result": {
          const pending = pendingBrowser.get(String(msg.id));
          if (pending) {
            clearTimeout(pending.timer);
            pendingBrowser.delete(String(msg.id));
            pending.resolve({ ok: !!msg.ok, result: msg.result, error: msg.error });
          }
          break;
        }
      }
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "term:data", id: msg.id, data: `\r\n[terminal error: ${err}]\r\n` }));
      }
    }
  });
  ws.on("close", () => {
    detachAll(ws);
    browserHosts.delete(ws);
  });
});

installAgentSetup();
initOrchestrator({
  broadcast: (msg) => {
    const data = JSON.stringify(msg);
    let sent = false;
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      client.send(data);
      sent = true;
    }
    return sent;
  },
  startTerm: (id, ws, bootCmd) => attachTerm(id, ws, null, 120, 32, false, bootCmd),
  writeTerm: termInput,
  stopTerm: killTerm,
  tailOf: termTail,
});

// Loopback only: nothing else on the network can reach the terminals.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Crux server on http://127.0.0.1:${PORT}`);
});

function shutdown() {
  stopAllPreviews();
  killAllTerms();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Windows has no SIGTERM to send: the desktop app asks over HTTP instead
// (local programs only: see security.ts), so chats are saved before quitting.
app.post("/api/quit", (_req, res) => {
  res.json({ ok: true });
  setTimeout(shutdown, 50);
});
