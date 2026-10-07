import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { PORT } from "./paths.js";

/**
 * Crux's server can open terminals, so only Crux itself may talk to it:
 * - it listens on 127.0.0.1 only (see index.ts), never the network;
 * - the Host header must be loopback, which defeats DNS rebinding (a site
 *   pointing its own domain at 127.0.0.1 still sends its own Host);
 * - a browser Origin, when present, must be the Crux UI. Websites you visit
 *   send their own Origin on fetch and WebSocket, so they are refused.
 * Requests without an Origin come from local programs (the agents' MCP
 * helpers, curl), which already run as you.
 */
const HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const UI_PORTS = [String(PORT), "5180", "5181"]; // own page, vite dev, app:fresh
const ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  ...UI_PORTS.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]),
]);

export function hostAllowed(host: string | undefined): boolean {
  return !!host && HOSTS.has(host.replace(/:\d+$/, "").toLowerCase());
}

export function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || ORIGINS.has(origin);
}

/** Express guard + CORS for the Crux UI origins only. */
export function guardHttp(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (!hostAllowed(req.headers.host) || !originAllowed(origin)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  next();
}

/** WebSocket upgrade check (terminals live on this socket). */
export function wsAllowed(req: IncomingMessage): boolean {
  return hostAllowed(req.headers.host) && originAllowed(req.headers.origin);
}
