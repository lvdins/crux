import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Manages a `mkdocs serve` child process for the docs repo, run through uv so
 * nothing needs to be installed globally. mkdocs live-reloads on file edits,
 * which is what gives the doc studio its instant preview.
 */
let proc: ChildProcess | null = null;
let log: string[] = [];
let state: "stopped" | "starting" | "running" | "error" = "stopped";

export function previewStatus() {
  return { state, port: config.preview.port, log: log.slice(-30) };
}

export function startPreview(): void {
  if (proc) return;
  const docs = Object.values(config.repos).find((r) => r.kind === "mkdocs");
  if (!docs) {
    state = "error";
    log.push("No mkdocs repo configured");
    return;
  }
  const reqs = path.join(docs.path, "requirements.txt");
  const args = ["tool", "run"];
  if (fs.existsSync(reqs)) args.push("--with-requirements", reqs);
  args.push("mkdocs", "serve", "-a", `127.0.0.1:${config.preview.port}`);

  state = "starting";
  log = [`$ uv ${args.join(" ")}`];
  proc = spawn("uv", args, { cwd: docs.path, stdio: ["ignore", "pipe", "pipe"] });

  const onData = (chunk: Buffer) => {
    const line = chunk.toString();
    log.push(line.trimEnd());
    if (line.includes("Serving on")) state = "running";
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("exit", (code) => {
    state = code === 0 || code === null ? "stopped" : "error";
    log.push(`mkdocs exited with code ${code}`);
    proc = null;
  });
  proc.on("error", (err) => {
    state = "error";
    log.push(String(err));
    proc = null;
  });
}

export function stopPreview(): void {
  proc?.kill();
  proc = null;
  state = "stopped";
}
