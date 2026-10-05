import express from "express";
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { config, addWorkspace, updateWorkspace, removeWorkspace, detectKind, expandHome } from "./config.js";
import { attachTerm, termInput, termResize, killTerm, detachAll, killAllTerms, openLog } from "./term.js";
import { startPreview, stopPreview, stopAllPreviews, previewStatus } from "./preview.js";
import { buildTree, sharedEndpoints } from "./tree.js";

const PORT = 8787;
let connectionsCache: { at: number; data: unknown } | null = null;
let featuresCache: { at: number; data: unknown } | null = null;
const app = express();
app.use(express.json());

// The UI may load from vite (:5180) or from the Tauri shell (tauri://) —
// both are foreign origins to this server, so allow them. Local tool only.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));

// Serve the built client when it exists, so the desktop app (and plain
// http://localhost:8787) works without vite.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
app.use(express.static(clientDist));

app.get("/api/config", (_req, res) => {
  res.json({
    repos: Object.fromEntries(
      Object.entries(config.repos).map(([k, r]) => [k, { label: r.label, kind: r.kind, path: r.path, pinned: !!r.pinned }]),
    ),
    user: os.userInfo().username,
  });
});

const descriptionsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../qualitylab.descriptions.json");

app.get("/api/tree", async (_req, res) => {
  const trees = buildTree();
  let descriptions: Record<string, Record<string, string>> = {};
  try {
    descriptions = JSON.parse(fs.readFileSync(descriptionsPath, "utf8"));
  } catch {
    // No descriptions file yet — the UI falls back gracefully.
  }
  res.json({ trees, shared: sharedEndpoints(trees), descriptions });
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

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
      }
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "term:data", id: msg.id, data: `\r\n[terminal error: ${err}]\r\n` }));
      }
    }
  });
  ws.on("close", () => detachAll(ws));
});

server.listen(PORT, () => {
  console.log(`QualityLab server on http://localhost:${PORT}`);
});

function shutdown() {
  stopAllPreviews();
  killAllTerms();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
