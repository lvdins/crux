import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * One `mkdocs serve` child per docs workspace, run through uv so nothing
 * needs to be installed globally. mkdocs live-reloads on file edits, which is
 * what gives the doc studio its instant preview.
 */
type State = "stopped" | "starting" | "running" | "error";

interface PreviewProc {
  proc: ChildProcess | null;
  log: string[];
  state: State;
  port: number;
}

const previews = new Map<string, PreviewProc>();

function slot(key: string): PreviewProc {
  let p = previews.get(key);
  if (!p) {
    // Stable port per workspace: base port + its position among docs repos.
    const docsKeys = Object.keys(config.repos).filter((k) => config.repos[k].kind === "mkdocs");
    const used = new Set([...previews.values()].map((v) => v.port));
    let port = config.preview.port + Math.max(0, docsKeys.indexOf(key));
    while (used.has(port)) port++;
    p = { proc: null, log: [], state: "stopped", port };
    previews.set(key, p);
  }
  return p;
}

export function previewStatus(key: string) {
  const p = slot(key);
  return { state: p.state, port: p.port, log: p.log.slice(-30) };
}

export function startPreview(key: string): void {
  const p = slot(key);
  if (p.proc) return;
  const docs = config.repos[key];
  if (!docs || docs.kind !== "mkdocs") {
    p.state = "error";
    p.log.push("Not a docs workspace");
    return;
  }
  const reqs = path.join(docs.path, "requirements.txt");
  const args = ["tool", "run"];
  if (fs.existsSync(reqs)) args.push("--with-requirements", reqs);
  args.push("mkdocs", "serve", "-a", `127.0.0.1:${p.port}`);

  p.state = "starting";
  p.log = [`$ uv ${args.join(" ")}`];
  const proc = spawn("uv", args, { cwd: docs.path, stdio: ["ignore", "pipe", "pipe"] });
  p.proc = proc;

  const onData = (chunk: Buffer) => {
    const line = chunk.toString();
    p.log.push(line.trimEnd());
    if (p.log.length > 200) p.log.splice(0, p.log.length - 200);
    if (line.includes("Serving on")) p.state = "running";
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("exit", (code) => {
    p.state = code === 0 || code === null ? "stopped" : "error";
    p.log.push(`mkdocs exited with code ${code}`);
    p.proc = null;
  });
  proc.on("error", (err) => {
    p.state = "error";
    p.log.push(String(err).includes("ENOENT") ? `uv not found — install it: ${process.platform === "darwin" ? "brew install uv" : "curl -LsSf https://astral.sh/uv/install.sh | sh"}` : String(err));
    p.proc = null;
  });
}

export function stopPreview(key: string): void {
  const p = previews.get(key);
  if (!p) return;
  p.proc?.kill();
  p.proc = null;
  p.state = "stopped";
}

export function stopAllPreviews(): void {
  for (const key of previews.keys()) stopPreview(key);
}
