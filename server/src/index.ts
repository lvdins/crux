import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { attachTerm, termInput, termResize, detachAll, killAllTerms } from "./term.js";
import { startPreview, stopPreview, previewStatus } from "./preview.js";
import { buildTree, sharedEndpoints } from "./tree.js";

const PORT = 8787;
const app = express();
app.use(express.json());

// The UI may load from vite (:5180) or from the Tauri shell (tauri://) —
// both are foreign origins to this server, so allow them. Local tool only.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
      Object.entries(config.repos).map(([k, r]) => [k, { label: r.label, kind: r.kind, path: r.path }]),
    ),
    preview: config.preview,
  });
});

app.get("/api/tree", (_req, res) => {
  const trees = buildTree();
  res.json({ trees, shared: sharedEndpoints(trees) });
});

app.post("/api/preview/start", (_req, res) => {
  startPreview();
  res.json(previewStatus());
});
app.post("/api/preview/stop", (_req, res) => {
  stopPreview();
  res.json(previewStatus());
});
app.get("/api/preview/status", (_req, res) => {
  res.json(previewStatus());
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
          attachTerm(msg.repo, ws, msg.cols | 0, msg.rows | 0, !!msg.fresh);
          break;
        case "term:input":
          termInput(msg.repo, String(msg.data ?? ""));
          break;
        case "term:resize":
          termResize(msg.repo, msg.cols | 0, msg.rows | 0);
          break;
      }
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "term:data", repo: msg.repo, data: `\r\n[terminal error: ${err}]\r\n` }));
      }
    }
  });
  ws.on("close", () => detachAll(ws));
});

server.listen(PORT, () => {
  console.log(`SuperQA server on http://localhost:${PORT}`);
});

function shutdown() {
  stopPreview();
  killAllTerms();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
