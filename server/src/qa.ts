import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { config, currentSettings, expandHome } from "./config.js";
import { broadcastAll, sendToTerm, startTask } from "./orchestrator.js";

/**
 * QA run panel: shows a qa-skills 2.0.0 round (qa-full-pass / qa-lite).
 * The round folder is the source of truth and Crux only reads it:
 * `<qaRoot>/<target>/round-<n>/` with run-log.md, timings.json, intake.md,
 * cases.md, lanes/<lane>/status.txt, findings.md, report/findings.json, wt/
 * and the shared `<qaRoot>/.locks/`. Gates are never re-implemented here:
 * the skill's own check_round.py decides, and its output is shown as is.
 */

export const BATCHES = ["Intake and plan", "Cases", "Lanes", "Second pass", "Report"] as const;

export type BatchStatus = "pending" | "running" | "paused" | "done" | "failed";
export interface GateLine {
  text: string;
  /** An open check (shown in red). */
  open: boolean;
}
export interface Gate {
  batch?: number;
  lane?: string;
  /** check_round.py ran (false: python3 or the script is missing). */
  ran: boolean;
  ok: boolean;
  code: number | null;
  lines: GateLine[];
  error?: string;
  at: string;
}
export interface Batch {
  n: number;
  name: string;
  status: BatchStatus;
  /** The batch's status block from run-log.md, as written. */
  block: string;
  fields: Record<string, string>;
  gate?: Gate;
}
export interface Lane {
  name: string;
  status: string;
  cases?: number;
  pass?: number;
  fail?: number;
  blocked?: number;
  not_tested?: number;
  /** Why it did not start or stopped (e.g. media without a J, K or L change). */
  reason?: string;
  fields: Record<string, string>;
}
export interface Case {
  id?: string;
  title: string;
}
export interface Finding {
  id: string;
  title: string;
  severity?: string;
  status?: string;
}
export interface WriteClass {
  name: string;
  granted: boolean;
  limits: string;
  cells: Record<string, string>;
}
export interface Round {
  target: string;
  n: number;
  dir: string;
  exists: boolean;
  tier: string;
  stale: string[];
  writeClasses: WriteClass[];
  batches: Batch[];
  /** First batch that isn't done (5 when all are). */
  current: number;
  /** Latest check_round.py result for the current batch, when it has run. */
  gate: Gate | null;
  lanes: Lane[];
  /** Stopped after Batch 2 for the user's go-ahead. */
  pause: { after: number; cases: { area: string; cases: Case[] }[] } | null;
  cases: { area: string; cases: Case[] }[];
  findings: Finding[];
  report: { findings: number; url?: string } | null;
  timings: { wall?: number; active?: number; pause?: number } | null;
  locks: { name: string; holder: string; at: string }[];
  worktrees: string[];
}

// --- Where things are -------------------------------------------------------

/** Setting `qaRoot` (blank: $HOME/qa-runs). */
export function qaRoot(): string {
  const set = currentSettings().qaRoot;
  return set ? path.resolve(expandHome(set)) : path.join(os.homedir(), "qa-runs");
}
/** Installed skills (CRUX_QA_SKILLS overrides, for tests). */
export const skillsDir = () => process.env.CRUX_QA_SKILLS || path.join(os.homedir(), ".claude", "skills");
const checkScript = () => path.join(skillsDir(), "qa-full-pass", "scripts", "check_round.py");

export function skillsInfo() {
  let version = "";
  for (const f of [["qa-skills", "VERSION"], ["qa-full-pass", "VERSION"]]) {
    version = readText(path.join(skillsDir(), ...f)).trim().split("\n")[0].slice(0, 40);
    if (version) break;
  }
  return { dir: skillsDir(), version, check: fs.existsSync(checkScript()), lite: fs.existsSync(path.join(skillsDir(), "qa-lite")) };
}

/** Folder names only: no separators, no leading dot (keeps out ".", ".." and .locks). */
export const TARGET_RE = /^[A-Za-z0-9][\w.-]{0,79}$/;
const N_RE = /^[1-9]\d{0,3}$/;
const LANE_RE = /^[\w-]{1,40}$/;
export const validTarget = (t: unknown): t is string => typeof t === "string" && TARGET_RE.test(t);
export const validN = (n: unknown) => N_RE.test(String(n ?? ""));

export function roundDir(root: string, target: string, n: number): string {
  if (!validTarget(target) || !validN(n)) throw new Error("Bad round");
  return path.join(root, target, `round-${n}`);
}

// --- Reading ----------------------------------------------------------------

const MAX_FILE = 2_000_000;
function readText(file: string): string {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
function readJson(file: string): any {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}
function dirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Targets and their round numbers, newest round first. */
export function listRounds(root: string, filter?: { target?: string; mr?: string }) {
  let targets = dirs(root).filter(validTarget);
  if (filter?.target) targets = targets.filter((t) => t === filter.target);
  if (filter?.mr) {
    const iid = filter.mr.replace(/^!/, "");
    targets = targets.filter((t) => new RegExp(`(^|[^\\d])${iid.replace(/\W/g, "")}($|[^\\d])`).test(t));
  }
  return targets.map((target) => ({
    target,
    rounds: dirs(path.join(root, target))
      .map((d) => /^round-([1-9]\d{0,3})$/.exec(d)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => b - a),
  }));
}

const clean = (s: string) => s.replace(/\*\*|__|`/g, "").trim();

/** `key: value` lines (also "- **Key:** value"). */
function fieldsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:[-*]\s+)?\**([A-Za-z][\w -]{0,30}?)\**\s*:\**\s*(.+)$/.exec(line);
    if (m) out[m[1].trim().toLowerCase().replace(/\s+/g, "_")] ??= clean(m[2]);
  }
  return out;
}

export function normStatus(s: string): BatchStatus {
  const v = s.toLowerCase();
  if (!v) return "pending";
  if (/fail|block|error/.test(v)) return "failed";
  if (/pause|await|waiting|go-ahead/.test(v)) return "paused";
  if (/done|pass|complete|finished|ok\b|green/.test(v)) return "done";
  if (/run|progress|active|start|ongoing/.test(v)) return "running";
  return "pending";
}

/** run-log.md: one status block per batch, under a "Batch N" heading. */
export function parseRunLog(text: string): Batch[] {
  const blocks = new Map<number, { title: string; lines: string[] }>();
  let cur: { title: string; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    const h = /^#{1,4}\s*Batch\s+([1-5])\b[\s:.\-–—]*(.*)$/i.exec(line);
    if (h) {
      // A later block for the same batch (a re-check) replaces the earlier one.
      cur = { title: clean(h[2]), lines: [] };
      blocks.set(Number(h[1]), cur);
    } else if (/^#{1,2}\s/.test(line)) {
      cur = null;
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return BATCHES.map((name, i) => {
    const b = blocks.get(i + 1);
    const block = b ? b.lines.join("\n").trim() : "";
    const fields = fieldsOf(block);
    return { n: i + 1, name: b?.title || name, status: normStatus(fields.status ?? fields.state ?? ""), block, fields };
  });
}

/** Markdown tables in a document: header cells → each row's cells. */
function tables(text: string): Record<string, string>[][] {
  const out: Record<string, string>[][] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) continue;
    const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map(clean);
    const head = cells(lines[i]).map((h) => h.toLowerCase());
    const rows: Record<string, string>[] = [];
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
      const c = cells(lines[i]);
      rows.push(Object.fromEntries(head.map((h, j) => [h, c[j] ?? ""])));
    }
    out.push(rows);
  }
  return out;
}

/** Bullets under the first heading matching `re`. */
function section(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (/^#{1,4}\s/.test(line)) inside = re.test(line);
    else if (inside) {
      const m = /^\s*[-*]\s+(.+)$/.exec(line);
      if (m) out.push(clean(m[1]));
    }
  }
  return out;
}

/** intake.md: tier, stale facts and the write-class table (default: not granted). */
export function parseIntake(text: string) {
  const tier = /\btier\b\**\s*[:=|]\s*\**\s*(light|standard|deep)/i.exec(text)?.[1] ?? "";
  const yes = /^(yes|y|granted|allowed|allow|true|on|✓|✅)\b/i;
  const writeClasses: WriteClass[] = [];
  for (const rows of tables(text)) {
    const keys = Object.keys(rows[0] ?? {});
    const nameKey = keys.find((k) => /class/.test(k));
    if (!nameKey) continue;
    const grantKey = keys.find((k) => /grant|allow|default|decision/.test(k));
    const limitKey = keys.find((k) => /limit|scope|note/.test(k));
    for (const r of rows) {
      if (!r[nameKey]) continue;
      writeClasses.push({ name: r[nameKey], granted: grantKey ? yes.test(r[grantKey]) : false, limits: limitKey ? r[limitKey] : "", cells: r });
    }
    break;
  }
  return { tier: tier ? tier[0].toUpperCase() + tier.slice(1).toLowerCase() : "", stale: section(text, /stale/i), writeClasses };
}

const CASE_ID = /^\[?([A-Z][A-Z0-9]{0,5}-?\d{1,4})\]?[\s:.\-–—]+/;

/** cases.md: cases grouped by area (each heading is an area). */
export function parseCases(text: string) {
  const areas: { area: string; cases: Case[] }[] = [];
  let area: { area: string; cases: Case[] } | null = null;
  let count = 0;
  const add = (raw: string) => {
    if (count >= 1000) return;
    if (!area) areas.push((area = { area: "General", cases: [] }));
    const t = clean(raw);
    const m = CASE_ID.exec(t);
    area.cases.push(m ? { id: m[1], title: t.slice(m[0].length).trim() } : { title: t });
    count++;
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^#{2,4}\s+(.+)$/.exec(line);
    if (h) {
      areas.push((area = { area: clean(h[1]), cases: [] }));
      continue;
    }
    const b = /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ x]\]\s+)?(.+)$/i.exec(line);
    if (b) {
      add(b[1]);
      continue;
    }
    // Table rows: first two cells (id, title).
    if (/^\s*\|/.test(line) && !/^\s*\|?\s*:?-{2,}/.test(line) && !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const c = line.trim().replace(/^\||\|$/g, "").split("|").map(clean).filter(Boolean);
      if (c.length) add(c.length > 1 && /^[A-Z][A-Z0-9]{0,5}-?\d{1,4}$/.test(c[0]) ? `${c[0]} ${c[1]}` : c.join(" · "));
    }
  }
  return areas.filter((a) => a.cases.length);
}

/** status.txt: `lane=api status=done cases=14 pass=11 fail=2 …` (last value of a key wins). */
export function parseLaneStatus(text: string, dirName: string): Lane {
  const fields: Record<string, string> = {};
  for (const m of text.matchAll(/([\w-]+)=("([^"]*)"|'([^']*)'|\S+)/g)) fields[m[1]] = m[3] ?? m[4] ?? m[2];
  const num = (k: string) => (/^\d+$/.test(fields[k] ?? "") ? Number(fields[k]) : undefined);
  return {
    name: LANE_RE.test(fields.lane ?? "") ? fields.lane : dirName,
    status: (fields.status ?? (text.trim() ? "unknown" : "not started")).toLowerCase(),
    cases: num("cases"),
    pass: num("pass"),
    fail: num("fail"),
    blocked: num("blocked"),
    not_tested: num("not_tested"),
    reason: fields.reason,
    fields,
  };
}

/** findings.md: one heading (or bullet) per finding, `F-01 Title` with Severity / Status lines. */
export function parseFindings(text: string): Finding[] {
  const out: Finding[] = [];
  let cur: Finding | null = null;
  for (const line of text.split("\n")) {
    const h = /^(?:#{2,4}|\s*[-*])\s+\[?([A-Z][A-Z0-9]{0,5}-\d{1,4})\]?[\s:.\-–—]*(.*)$/.exec(line);
    if (h) {
      cur = { id: h[1], title: clean(h[2]) };
      out.push(cur);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      cur = null;
      continue;
    }
    const f = cur && /^\s*(?:[-*]\s+)?\**(severity|status)\**\s*:\**\s*(.+)$/i.exec(line);
    if (cur && f) cur[f[1].toLowerCase() as "severity" | "status"] = clean(f[2]);
  }
  return out.slice(0, 500);
}

/** Findings to re-test: everything not already closed / verified / won't fix. */
export const openFindings = (list: Finding[]) => list.filter((f) => !/closed|verified|won.?t|invalid|duplicate|not a bug/i.test(f.status ?? ""));

function parseTimings(json: any) {
  if (!json || typeof json !== "object") return null;
  const src = json.totals && typeof json.totals === "object" ? json.totals : json;
  const pick = (k: string) => {
    for (const key of [k, `${k}_s`, `${k}_sec`, `${k}_seconds`]) if (typeof src[key] === "number") return src[key] as number;
    return undefined;
  };
  return { wall: pick("wall"), active: pick("active"), pause: pick("pause") };
}

function parseReport(json: any) {
  if (!json) return null;
  const list = Array.isArray(json) ? json : Array.isArray(json.findings) ? json.findings : [];
  const url = typeof json.url === "string" && /^https:\/\//.test(json.url) ? json.url : undefined;
  return { findings: list.length, url };
}

function locksIn(root: string) {
  const dir = path.join(root, ".locks");
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .slice(0, 50)
      .map((e) => {
        const file = path.join(dir, e.name);
        return { name: e.name, holder: readText(file).trim().split("\n")[0].slice(0, 200), at: fs.statSync(file).mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

/** Gate results by round + batch / lane (kept until the round changes). */
const gates = new Map<string, Gate>();
const gateKey = (target: string, n: number, what: string) => `${target}/${n}/${what}`;

/** Everything the panel shows for one round. Missing files read as empty. */
export function readRound(root: string, target: string, n: number): Round {
  const dir = roundDir(root, target, n);
  const intake = parseIntake(readText(path.join(dir, "intake.md")));
  const batches = parseRunLog(readText(path.join(dir, "run-log.md")));
  for (const b of batches) b.gate = gates.get(gateKey(target, n, `b${b.n}`));
  const lanes = dirs(path.join(dir, "lanes")).filter((d) => LANE_RE.test(d)).map((d) => parseLaneStatus(readText(path.join(dir, "lanes", d, "status.txt")), d));
  const cases = parseCases(readText(path.join(dir, "cases.md")));
  const current = (batches.find((b) => b.status !== "done") ?? batches[4]).n;
  const [b2, b3] = [batches[1].status, batches[2].status];
  // Batch 3 starting ends the pause, even if Batch 2's block still says "awaiting".
  const paused = (b2 === "paused" || b2 === "done") && b3 === "pending";
  return {
    target,
    n,
    dir,
    exists: fs.existsSync(dir),
    tier: intake.tier,
    stale: intake.stale,
    writeClasses: intake.writeClasses,
    batches,
    current,
    gate: gates.get(gateKey(target, n, `b${current}`)) ?? null,
    lanes,
    pause: paused ? { after: 2, cases } : null,
    cases,
    findings: parseFindings(readText(path.join(dir, "findings.md"))),
    report: parseReport(readJson(path.join(dir, "report", "findings.json"))),
    timings: parseTimings(readJson(path.join(dir, "timings.json"))),
    locks: locksIn(root),
    worktrees: dirs(path.join(dir, "wt")),
  };
}

// --- Gates (the skill's own check_round.py) ---------------------------------

const OPEN_LINE = /^\s*(✗|×|❌|\[ ?\]|-\s*\[ \]|open\b|fail|error|missing|block|todo\b)/i;

export function runCheck(dir: string, what: { batch?: number; lane?: string }): Promise<Gate> {
  const script = checkScript();
  const args = ["-I", script, dir];
  if (what.batch) args.push("--batch", String(what.batch));
  if (what.lane) {
    if (!LANE_RE.test(what.lane)) return Promise.reject(new Error("Bad lane"));
    args.push("--lane", what.lane);
  }
  const base = { batch: what.batch, lane: what.lane, at: new Date().toISOString() };
  if (!fs.existsSync(script)) {
    return Promise.resolve({ ...base, ran: false, ok: false, code: null, lines: [], error: `check_round.py not found at ${script}` });
  }
  return new Promise((resolve) => {
    execFile("python3", args, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, cwd: dir }, (err, stdout, stderr) => {
      const e = err as { code?: unknown; killed?: boolean; message: string } | null;
      const code = e ? e.code : 0;
      if (typeof code !== "number" || e?.killed) {
        // Not an exit code: python3 missing, timed out, or killed.
        const why = code === "ENOENT" ? "python3 not found" : e?.killed ? "check_round.py timed out (30 s)" : e?.message;
        return resolve({ ...base, ran: false, ok: false, code: null, lines: [], error: why });
      }
      const lines = `${stdout}\n${stderr}`
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .slice(0, 300)
        .map((text) => ({ text, open: code !== 0 && OPEN_LINE.test(text) }));
      resolve({ ...base, ran: true, ok: code === 0, code, lines });
    });
  });
}

export async function checkRound(root: string, target: string, n: number, what: { batch?: number; lane?: string }) {
  const gate = await runCheck(roundDir(root, target, n), what);
  gates.set(gateKey(target, n, what.lane ? `l${what.lane}` : `b${what.batch ?? 0}`), gate);
  return gate;
}

// --- Watching the open round ------------------------------------------------

interface Watch {
  w: fs.FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
}
const watches = new Map<string, Watch>();
const MAX_WATCHES = 4;

async function pushRound(root: string, target: string, n: number) {
  const w = watches.get(`${root}|${target}/${n}`);
  if (w?.busy) return;
  if (w) w.busy = true;
  try {
    const round = readRound(root, target, n);
    // The gate of the batch in progress follows the files.
    if (round.exists) {
      round.gate = await checkRound(root, target, n, { batch: round.current });
      round.batches[round.current - 1].gate = round.gate;
    }
    broadcastAll({ type: "qa:round", ...round });
  } finally {
    if (w) w.busy = false;
  }
}

/** Watch a round (the panel opened it); the oldest watch goes past MAX_WATCHES. */
export function watchRound(root: string, target: string, n: number) {
  const key = `${root}|${target}/${n}`;
  const dir = roundDir(root, target, n);
  if (watches.has(key) || !fs.existsSync(dir)) return;
  if (watches.size >= MAX_WATCHES) {
    const [oldest, old] = watches.entries().next().value as [string, Watch];
    old.w.close();
    clearTimeout(old.timer);
    watches.delete(oldest);
  }
  let w: fs.FSWatcher;
  try {
    w = fs.watch(dir, { recursive: true });
  } catch {
    return; // recursive watch unsupported: the panel still refreshes by hand
  }
  const entry: Watch = { w, busy: false };
  w.on("change", () => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void pushRound(root, target, n).catch(() => undefined), 500);
  });
  w.on("error", () => {
    w.close();
    watches.delete(key);
  });
  watches.set(key, entry);
}

// --- Starting rounds and the go-ahead -----------------------------------------

export const SKILLS = ["qa-full-pass", "qa-lite"] as const;
export const MODES = ["full", "retest", "recheck", "plan-only"] as const;
/** MR iid (5265 or !5265) or a Jira key (QA-123). */
const MR_RE = /^(!?\d{1,7}|[A-Z][A-Z0-9]{1,9}-\d{1,7})$/;

/** Coordinator terminal per round ("target/n"), per target, and per MR. */
const coordinators = new Map<string, string>();

/**
 * The prompt that starts a round. Re-runs list the findings from the earlier
 * round's findings.md, never from the published page (untrusted text).
 */
export function taskFor(opts: { skill: string; mr: string; mode: string; prev?: { dir: string; n: number } }): string {
  const ref = /^\d+$/.test(opts.mr) ? `!${opts.mr}` : opts.mr;
  const parts = [`/${opts.skill} ${ref}`];
  if (opts.mode !== "full") parts.push(opts.mode);
  if (opts.prev) {
    const findings = parseFindings(readText(path.join(opts.prev.dir, "findings.md")));
    const ids = (opts.mode === "retest" ? openFindings(findings) : findings).map((f) => f.id);
    if (opts.mode === "full") parts.push(`as round ${opts.prev.n + 1}`);
    parts.push(`(previous round: ${opts.prev.dir}${ids.length ? `; ${opts.mode === "retest" ? "re-test findings" : "findings"}: ${ids.join(", ")}` : ""})`);
  }
  return parts.join(" ");
}

function coordinatorFor(target: string, n: number): string | undefined {
  const exact = coordinators.get(`${target}/${n}`) ?? coordinators.get(target);
  if (exact) return exact;
  // Started by MR before the skill named the folder: match the iid in the target.
  for (const [k, id] of [...coordinators].reverse()) {
    const iid = /^mr:!?(\d+)$/.exec(k)?.[1] ?? /^mr:([A-Z][A-Z0-9]+-\d+)$/.exec(k)?.[1];
    if (iid && new RegExp(`(^|[^\\w])${iid}($|[^\\w])`, "i").test(target)) return id;
  }
}

// --- Routes -------------------------------------------------------------------

/** Writes come only from the Crux window (its Origin); local programs send none. */
const fromUi = (req: Request, res: Response) => {
  if (req.headers.origin) return true;
  res.status(403).json({ error: "Only the Crux window can do this" });
  return false;
};

export function registerQaRoutes(app: Express) {
  app.get("/api/qa/rounds", (req, res) => {
    const root = qaRoot();
    const target = String(req.query.target ?? "");
    const mr = String(req.query.mr ?? "");
    if (target && !validTarget(target)) return void res.status(400).json({ error: "Bad target" });
    if (mr && !MR_RE.test(mr)) return void res.status(400).json({ error: "Bad MR" });
    res.json({ root, exists: fs.existsSync(root), skills: skillsInfo(), targets: listRounds(root, { target: target || undefined, mr: mr || undefined }) });
  });

  app.get("/api/qa/rounds/:target/:n", (req, res) => {
    const { target, n } = req.params;
    if (!validTarget(target) || !validN(n)) return void res.status(400).json({ error: "Bad round" });
    const root = qaRoot();
    watchRound(root, target, Number(n));
    res.json({ ...readRound(root, target, Number(n)), skills: skillsInfo(), coordinator: coordinatorFor(target, Number(n)) ?? null });
  });

  app.get("/api/qa/rounds/:target/:n/check", async (req, res) => {
    const { target, n } = req.params;
    const batch = String(req.query.batch ?? "");
    const lane = String(req.query.lane ?? "");
    if (!validTarget(target) || !validN(n)) return void res.status(400).json({ error: "Bad round" });
    if ((batch && !/^[1-5]$/.test(batch)) || (lane && !LANE_RE.test(lane)) || (!batch && !lane)) {
      return void res.status(400).json({ error: "Give batch=1…5 or lane=<name>" });
    }
    try {
      res.json(await checkRound(qaRoot(), target, Number(n), { batch: batch ? Number(batch) : undefined, lane: lane || undefined }));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/qa/start", (req, res) => {
    if (!fromUi(req, res)) return;
    const { ws, mr, skill, mode, target, n } = req.body ?? {};
    if (!config.repos[String(ws)]) return void res.status(400).json({ error: "Unknown workspace" });
    if (!MR_RE.test(String(mr ?? ""))) return void res.status(400).json({ error: "MR iid (e.g. 5265) or a Jira key" });
    if (!SKILLS.includes(skill) || !MODES.includes(mode)) return void res.status(400).json({ error: "Bad skill or mode" });
    let prev: { dir: string; n: number } | undefined;
    if (target !== undefined || n !== undefined) {
      if (!validTarget(target) || !validN(n)) return void res.status(400).json({ error: "Bad round" });
      prev = { dir: roundDir(qaRoot(), target, Number(n)), n: Number(n) };
    }
    try {
      const task = taskFor({ skill, mr: String(mr), mode, prev });
      const title = `QA ${/^\d+$/.test(String(mr)) ? `!${mr}` : mr}${mode === "full" ? "" : ` ${mode}`}`;
      const started = startTask({ ws: String(ws), kind: "claude", task, title });
      coordinators.set(`mr:${mr}`, started.id);
      if (prev) coordinators.set(mode === "full" ? `${target}/${prev.n + 1}` : target, started.id);
      res.json({ ...started, task });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // The skill continues past the pause only on the user's own message: this
  // types it into the coordinator's chat, as if the user had.
  app.post("/api/qa/go", (req, res) => {
    if (!fromUi(req, res)) return;
    const { target, n, note, action } = req.body ?? {};
    if (!validTarget(target) || !validN(n)) return void res.status(400).json({ error: "Bad round" });
    const text = typeof note === "string" ? note.trim().slice(0, 4000) : "";
    if (action === "changes" && !text) return void res.status(400).json({ error: "Write the changes first" });
    const term = coordinatorFor(target, Number(n));
    if (!term) return void res.status(404).json({ error: "This round wasn't started from Crux: type your go-ahead in its chat" });
    const msg =
      action === "changes"
        ? `Before Batch 3 of ${target} round ${n}, change the cases: ${text}`
        : `Go: the cases for ${target} round ${n} are reviewed, continue with Batch 3.${text ? ` Note: ${text}` : ""}`;
    try {
      sendToTerm(term, msg);
      res.json({ ok: true, term });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });
}
