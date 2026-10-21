import fs from "node:fs";
import path from "node:path";
import type express from "express";
import { config, qaRoot, saveConfig } from "./config.js";
import { CRUX_HOME } from "./paths.js";

/**
 * Write guard: the browser's page script (netRecorder.js) answers non-GET
 * requests to lab / preview hosts itself unless a write class granted in
 * the round's intake.md covers them. This module turns the intake's
 * write-class table into that policy, keeps the per-round log of blocked
 * and allowed writes, and flags leaks (a write that reached the network
 * outside a grant). `decide()` here and in netRecorder.js must agree.
 */

export type GuardMode = "allow" | "ask" | "block";
/** Classes with a built-in rule; everything else matches its Limits' hosts / paths. */
export type ClassKey = "entities" | "production" | "admin" | "fixtures" | "stripe" | "other";

export interface GuardRule {
  cls: string;
  key: ClassKey;
  mode: GuardMode;
  /** Who granted it and the limits, quoted in the log. */
  grant: string;
  restore: string;
  /** entities: the run prefix `qa-<target>-r<n>-`. */
  prefix?: string;
  hosts: string[];
  /** Path globs (`/gapi/admin/*`), matched from the start of the path. */
  paths: string[];
}

export interface GuardPolicy {
  round: string | null;
  prefix: string | null;
  /** A request goes through the guard when its host contains one of these. */
  hosts: string[];
  rules: GuardRule[];
}

export interface GuardDecision {
  act: "pass" | GuardMode;
  cls?: string;
  grant?: string;
  restore?: string;
}

export const DEFAULT_GUARD_HOSTS = ["lab", "vercel.app", "preview"];
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const ROUND_RE = /^([A-Za-z0-9._-]+)\/round-(\d+)$/;
const WS_RE = /^[\w.-]{1,64}$/;

export { qaRoot };

/** "<target>/round-<n>" → its folder, target and number (null if malformed). */
export function parseRound(round: string): { dir: string; target: string; n: number } | null {
  const m = ROUND_RE.exec(round);
  if (!m || m[1].startsWith(".")) return null;
  return { dir: path.join(qaRoot(), m[1], `round-${m[2]}`), target: m[1], n: Number(m[2]) };
}

export const runPrefix = (target: string, n: number) => `qa-${target}-r${n}-`;

export function guardHosts(): string[] {
  const saved = config.settings?.guardHosts;
  return Array.isArray(saved) ? saved.filter((h): h is string => typeof h === "string") : DEFAULT_GUARD_HOSTS;
}

const classKey = (name: string): ClassKey => {
  const s = name.toLowerCase();
  if (/entit|this run|run creates/.test(s)) return "entities";
  if (/prod/.test(s)) return "production";
  if (/admin/.test(s)) return "admin";
  if (/fixture/.test(s)) return "fixtures";
  if (/stripe/.test(s)) return "stripe";
  return "other";
};

const modeOf = (cell: string): GuardMode => {
  const s = cell.toLowerCase().replace(/[*_`]/g, "").trim();
  if (/ask/.test(s)) return "ask";
  if (/^(yes|y|allowed|granted|true|✅|✓)\b/.test(s) || /^(✅|✓)/.test(s)) return "allow";
  return "block";
};

/** Hosts and path globs named in a Limits cell (backticked or bare). */
function scopeOf(cell: string): { hosts: string[]; paths: string[] } {
  const hosts: string[] = [];
  const paths: string[] = [];
  for (let tok of cell.split(/[\s,;`|()]+/)) {
    tok = tok.replace(/[.:]+$/, "");
    if (!tok) continue;
    try {
      if (/^https?:\/\//i.test(tok)) {
        const u = new URL(tok);
        hosts.push(u.hostname.toLowerCase());
        if (u.pathname !== "/") paths.push(u.pathname);
        continue;
      }
    } catch {
      continue;
    }
    if (tok.startsWith("/")) paths.push(tok);
    else if (/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(tok)) hosts.push(tok.toLowerCase());
  }
  return { hosts, paths };
}

/** Rows of the `Write class | Allowed? | Granted by | Limits | Restore` table. */
export function parseWriteClasses(md: string): { cls: string; allowed: string; grantedBy: string; limits: string; restore: string }[] {
  const lines = md.split(/\r?\n/);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const head = cells(lines[i]).map((c) => c.toLowerCase().replace(/[*_`?]/g, "").trim());
    if (!lines[i].includes("|") || head[0] !== "write class") continue;
    const col = (name: string) => head.findIndex((h) => h.startsWith(name));
    const [a, g, l, r] = [col("allowed"), col("granted"), col("limits"), col("restore")];
    const rows = [];
    for (let j = i + 1; j < lines.length && lines[j].includes("|"); j++) {
      const c = cells(lines[j]);
      if (c.every((x) => /^:?-+:?$/.test(x) || !x)) continue;
      rows.push({ cls: c[0] ?? "", allowed: c[a] ?? "", grantedBy: c[g] ?? "", limits: c[l] ?? "", restore: c[r] ?? "" });
    }
    return rows.filter((row) => row.cls);
  }
  return [];
}

/** The round's write classes as a policy. Every class blocks unless granted; production always blocks. */
export function buildPolicy(md: string, round: string | null, hosts: string[] = guardHosts()): GuardPolicy {
  const r = round ? parseRound(round) : null;
  const prefix = r ? runPrefix(r.target, r.n) : null;
  const rules: GuardRule[] = parseWriteClasses(md).map((row) => {
    const key = classKey(row.cls);
    const scope = scopeOf(row.limits);
    const mode = key === "production" ? "block" : modeOf(row.allowed);
    const quote = [row.grantedBy, row.limits].filter((x) => x && !/^[-–—]$/.test(x)).join(" · ");
    const rule: GuardRule = { cls: row.cls, key, mode, grant: mode === "block" ? "" : quote || "intake.md", restore: row.restore, ...scope };
    if (key === "entities") rule.prefix = prefix ?? undefined;
    if (key === "admin") rule.paths.push("/gapi/admin/*");
    if (key === "stripe") rule.hosts.push("stripe.com");
    return rule;
  });
  return { round: r ? round : null, prefix, hosts, rules };
}

const hostIs = (host: string, h: string) => {
  const bare = h.replace(/^\*\./, "");
  return host === bare || host.endsWith("." + bare);
};
const globRe = (glob: string) => new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));

function hits(rule: GuardRule, host: string, url: string, pathname: string, body: string): boolean {
  if (rule.key === "entities") return !!rule.prefix && (url.includes(rule.prefix) || body.includes(rule.prefix));
  if (!rule.hosts.length && !rule.paths.length) return false;
  return (!rule.hosts.length || rule.hosts.some((h) => hostIs(host, h))) && (!rule.paths.length || rule.paths.some((p) => globRe(p).test(pathname)));
}

/** What the guard does with one request (same rules as netRecorder.js). */
export function decide(policy: GuardPolicy, method: string, url: string, body?: string | null): GuardDecision {
  if (SAFE.has(method.toUpperCase())) return { act: "pass" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { act: "pass" };
  }
  const host = u.hostname.toLowerCase();
  const matched = policy.rules.filter((r) => hits(r, host, url, u.pathname, body ?? ""));
  const prod = matched.find((r) => r.key === "production");
  if (!prod && !policy.hosts.some((h) => h && host.includes(h.toLowerCase()))) return { act: "pass" };
  // A refusal wins over a grant: a prefixed entity under a blocked class stays blocked.
  const pick = prod ?? matched.find((r) => r.mode === "block") ?? matched.find((r) => r.mode === "ask") ?? matched.find((r) => r.mode === "allow");
  if (!pick) return { act: "block", cls: "unclassified" };
  const act = pick.key === "production" ? "block" : pick.mode;
  return { act, cls: pick.cls, grant: act === "allow" ? pick.grant : undefined, restore: pick.restore || undefined };
}

/** Policy for a round (no round: every guarded write blocks). */
export function policyFor(round: string | null): GuardPolicy {
  const r = round ? parseRound(round) : null;
  let md = "";
  if (r) {
    try {
      md = fs.readFileSync(path.join(r.dir, "intake.md"), "utf8");
    } catch {
      /* no intake yet: nothing granted */
    }
  }
  return buildPolicy(md, r ? round : null);
}

/** Rounds under the QA root, newest number first per target. */
export function listRounds(): string[] {
  const out: string[] = [];
  try {
    for (const target of fs.readdirSync(qaRoot())) {
      if (target.startsWith(".")) continue;
      try {
        for (const d of fs.readdirSync(path.join(qaRoot(), target))) if (/^round-\d+$/.test(d)) out.push(`${target}/${d}`);
      } catch {
        /* not a folder */
      }
    }
  } catch {
    /* no QA root */
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
}

/* ---------- log ---------- */

export interface GuardLogEntry {
  key: string;
  time: number;
  type: string;
  method: string;
  url: string;
  status: number;
  blocked: boolean;
  cls: string | null;
  grant: string | null;
  body: string | null;
  leak?: boolean;
  restore?: string;
}

const LOG_DIR = path.join(CRUX_HOME, "guard");
const MAX_LOG = 5000;
const logFile = (ws: string, round: string | null) => path.join(LOG_DIR, `${ws}--${(round ?? "no-round").replace("/", "--")}.json`);

export function readLog(ws: string, round: string | null): GuardLogEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(logFile(ws, round), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeLog(ws: string, round: string | null, entries: GuardLogEntry[]) {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  const file = logFile(ws, round);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries.slice(-MAX_LOG), null, 1) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The report's "Writes made" line. */
export function writesMade(entries: GuardLogEntry[]): string {
  const allowed = entries.filter((e) => !e.blocked && !e.leak);
  const blocked = entries.filter((e) => e.blocked).length;
  const leaks = entries.filter((e) => e.leak);
  const classes = [...new Set(allowed.map((e) => e.cls).filter(Boolean))].join(", ");
  let line = `Writes made: ${allowed.length} allowed${classes ? ` (${classes})` : ""}, ${blocked} blocked by the write guard`;
  if (leaks.length) line += `, ${leaks.length} outside a grant: ${leaks.map((e) => `${e.method} ${e.url}`).join("; ")}`;
  return line + ".";
}

/** Entries pushed from the UI (raw __qlNet rows); returns the new leaks. */
export function recordLog(ws: string, round: string | null, raw: unknown[]): GuardLogEntry[] {
  const policy = policyFor(round);
  const log = readLog(ws, round);
  const seen = new Set(log.map((e) => e.key));
  const leaks: GuardLogEntry[] = [];
  for (const r of raw.slice(0, 500) as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const method = String(r.method ?? "").toUpperCase();
    const url = String(r.url ?? "").slice(0, 2000);
    const key = `${String(r.page ?? "")}:${Number(r.id) || 0}`;
    if (SAFE.has(method) || !r.guarded || seen.has(key)) continue;
    seen.add(key);
    const body = typeof r.reqBody === "string" ? r.reqBody.slice(0, 2000) : null;
    const blocked = !!r.blocked;
    const grant = typeof r.grant === "string" ? r.grant.slice(0, 300) : null;
    const entry: GuardLogEntry = {
      key,
      time: Number(r.start) || Date.now(),
      type: String(r.type ?? "fetch").slice(0, 10),
      method: method.slice(0, 10),
      url,
      status: Number(r.status) || 0,
      blocked,
      cls: typeof r.class === "string" ? r.class.slice(0, 80) : null,
      grant,
      body,
    };
    // Reached the network: check it against the round's own policy too.
    if (!blocked) {
      const d = decide(policy, method, url, body);
      const askedOk = d.act === "ask" && !!grant;
      if (d.act === "block" || (d.act === "ask" && !askedOk)) {
        entry.leak = true;
        entry.cls = d.cls ?? entry.cls;
        entry.restore = d.restore || "Undo the change by hand and note it under restore steps in env.md.";
        leaks.push(entry);
      }
    }
    log.push(entry);
  }
  writeLog(ws, round, log);
  return leaks;
}

/* ---------- routes ---------- */

// Same check as index.ts's fromUi: writes only from the Crux window (it sends an Origin).
const fromUi = (req: express.Request, res: express.Response) => {
  if (req.headers.origin) return true;
  res.status(403).json({ error: "Only the Crux window can change the write guard" });
  return false;
};
type Broadcast = (msg: Record<string, unknown>) => void;

const roundParam = (v: unknown): string | null | false => {
  if (v === undefined || v === "") return null;
  return typeof v === "string" && parseRound(v) ? v : false;
};

export function guardRoutes(app: express.Express, broadcast: Broadcast): void {
  app.get("/api/guard/rounds", (_req, res) => res.json({ root: qaRoot(), rounds: listRounds() }));
  app.get("/api/guard/policy", (req, res) => {
    const round = roundParam(req.query.round);
    if (round === false) return void res.status(400).json({ error: "round must look like <target>/round-<n>" });
    res.json(policyFor(round));
  });
  app.get("/api/guard/log", (req, res) => {
    const ws = String(req.query.ws ?? "");
    const round = roundParam(req.query.round);
    if (!WS_RE.test(ws) || round === false) return void res.status(400).json({ error: "Bad ws or round" });
    const entries = readLog(ws, round);
    res.json({ entries, writesMade: writesMade(entries) });
  });
  app.post("/api/guard/log", (req, res) => {
    if (!fromUi(req, res)) return;
    const ws = String(req.body?.ws ?? "");
    const round = roundParam(req.body?.round);
    if (!WS_RE.test(ws) || round === false || !Array.isArray(req.body?.entries)) return void res.status(400).json({ error: "Bad ws, round or entries" });
    const leaks = recordLog(ws, round, req.body.entries);
    for (const leak of leaks) broadcast({ type: "guard:leak", ws, round, entry: leak });
    res.json({ leaks });
  });
  app.post("/api/guard/hosts", (req, res) => {
    if (!fromUi(req, res)) return;
    const hosts = Array.isArray(req.body?.hosts) ? req.body.hosts : null;
    if (!hosts) return void res.status(400).json({ error: "hosts must be a list" });
    const clean = [...new Set(hosts.map((h: unknown) => String(h).trim().toLowerCase()).filter((h: string) => /^[a-z0-9.*-]{1,100}$/.test(h)))].slice(0, 50) as string[];
    config.settings = { ...config.settings, guardHosts: clean };
    saveConfig();
    res.json({ hosts: clean });
  });
}
