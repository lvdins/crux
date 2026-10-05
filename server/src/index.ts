import express from "express";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { AgentSession } from "./agent.js";
import { startPreview, stopPreview, previewStatus } from "./preview.js";
import { buildTree, sharedEndpoints } from "./tree.js";

const PORT = 8787;
const app = express();
app.use(express.json());

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
  const defaultRepo = Object.values(config.repos)[0];
  let session = new AgentSession(defaultRepo.path, (event) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  });

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "setRepo" && config.repos[msg.repo]) {
      session.setCwd(config.repos[msg.repo].path);
      ws.send(JSON.stringify({ type: "repoSet", repo: msg.repo }));
    } else if (msg.type === "chat" && typeof msg.text === "string" && msg.text.trim()) {
      void session.send(msg.text);
    }
  });
});

server.listen(PORT, () => {
  console.log(`SuperQA server on http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  stopPreview();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopPreview();
  process.exit(0);
});
