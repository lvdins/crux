import express from "express";
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { currentSettings, MODE_PRESETS, type Settings } from "./config.js";
import { config, saveConfig, userConfigPath, addWorkspace, updateWorkspace, removeWorkspace, detectKind, expandHome } from "./config.js";
import { attachTerm, termInput, termResize, killTerm, detachAll, killAllTerms, openLog, termProcess } from "./term.js";
import { startPreview, stopPreview, stopAllPreviews, previewStatus } from "./preview.js";
import { buildTree, sharedEndpoints } from "./tree.js";
import { installAgentSetup } from "./agent-setup.js";
import { latestRelease, installRelease, isNewer } from "./update.js";
import { guardHttp, wsAllowed } from "./security.js";
import { pipelinesFor } from "./pipelines.js";
import { adoptLoginShellPath, checkTools, CRUX_HOME, PACKAGED, PORT, rootPath } from "./paths.js";

adoptLoginShellPath();

let connectionsCache: { at: number; data: unknown } | null = null;
let featuresCache: { at: number; data: unknown } | null = null;
const app = express();

// Only the Crux UI (tauri://, vite dev, its own page) may call the API;
// see security.ts. Runs before body parsing so refused requests cost nothing.
app.use(guardHttp);
app.options("*", (_req, res) => res.sendStatus(204));
app.use(express.json());

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
  if (body.mode === "qa" || body.mode === "regular") next = { ...MODE_PRESETS[body.mode] };
  for (const k of ["browser", "network", "picker", "qaPanels", "connections", "jira"] as const) {
    if (typeof body[k] === "boolean") next[k] = body[k];
  }
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
  // Bundled folder descriptions are written for the Giraffe360 suites; a
  // teammate's workspace keys differ, so fall back by suite type.
  for (const t of trees) {
    if (!descriptions[t.key]) {
      const fallback = descriptions[t.kind === "playwright" ? "e2e" : "api"];
      if (fallback) descriptions[t.key] = fallback;
    }
  }
  res.json({ trees, shared: sharedEndpoints(trees), descriptions });
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
