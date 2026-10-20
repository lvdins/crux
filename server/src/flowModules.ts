import path from "node:path";
import type { FlowModule, GraphNode } from "./activity.js";
import { buildFeatureMap, featureOf, INFRA_MODULES, normEndpoint } from "./features.js";
import { termCwd } from "./term.js";

/**
 * Which product module (dashboard feature) an agent's step works in, from the
 * feature map: file paths under src/modules or src/app, the test files linked
 * to each feature, and the pages / /gapi endpoints it owns. Agents can also
 * declare one ("now testing: Billing") plus the modules they'll test next.
 */

export interface ModuleEntry {
  id: string;
  label: string;
  /** Page routes ("/manage-workspace/presets", "/projects/:id"). */
  pages: string[];
  /** Normalized endpoint templates ("gapi/dashboard/presets/{}"). */
  endpoints: string[];
  /** Linked E2E / API test files (repo-relative) and how many reasons link them. */
  tests: { file: string; weight: number }[];
}

const TTL = 5 * 60_000;
let index: { at: number; entries: Map<string, ModuleEntry>; fixed: boolean } | null = null;

/** Tests: use these entries instead of the real feature map (null = real one again). */
export function setModuleIndex(entries: ModuleEntry[] | null): void {
  index = entries ? { at: Date.now(), entries: new Map(entries.map((e) => [e.id, e])), fixed: true } : null;
}

function modules(): Map<string, ModuleEntry> {
  if (index && (index.fixed || Date.now() - index.at < TTL)) return index.entries;
  const entries = new Map<string, ModuleEntry>();
  try {
    for (const f of buildFeatureMap().features) {
      entries.set(f.id, {
        id: f.id,
        label: f.label,
        pages: f.pages.map((p) => p.route),
        endpoints: f.endpoints.map((e) => e.path),
        tests: [...f.e2e, ...f.api].map((l) => ({ file: l.file, weight: l.via.length })),
      });
    }
  } catch {
    /* repo unreadable: no modules until next rebuild */
  }
  index = { at: Date.now(), entries, fixed: false };
  return entries;
}

const toModule = (e: ModuleEntry): FlowModule => ({ id: e.id, label: e.label });
const segs = (p: string) => p.split("/").filter(Boolean);

/* ---------------- candidates from a tool call ---------------- */

const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath"];
const URL_KEYS = ["url", "uri", "endpoint"];
// Paths, URLs and pytest node ids inside a shell command.
const CMD_TOKEN = /https?:\/\/[^\s'"`<>|;]+|[\w.@~()[\]-]*\/[\w.@/()[\]:-]+|\b[\w.-]+\.(?:py|tsx?|jsx?|mjs)(?:::[\w[\]:-]+)?/g;

function candidates(node: GraphNode, raw: { toolInput?: Record<string, unknown> }) {
  const files: string[] = [];
  const urls: string[] = [];
  const input = raw.toolInput ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  for (const k of PATH_KEYS) if (str(input[k])) files.push(str(input[k]));
  if (Array.isArray(input.edits)) for (const e of input.edits) if (str(e?.file_path)) files.push(str(e.file_path));
  for (const f of node.meta.files ?? []) files.push(f);
  for (const k of URL_KEYS) if (str(input[k])) urls.push(str(input[k]));
  if (node.meta.url) urls.push(node.meta.url);
  const cmd = str(input.command);
  for (const m of cmd.match(CMD_TOKEN) ?? []) {
    const t = m.replace(/[),.]+$/, "");
    const gapi = t.match(/(?:^|\/)gapi\/.*/)?.[0];
    if (/^https?:\/\//.test(t)) urls.push(t);
    else if (gapi) urls.push(gapi); // "localhost:8000/gapi/…"
    else files.push(t);
  }
  // A bare route ("/manage-workspace/presets/") can also be a URL path.
  return { files, urls: [...urls, ...files.filter((f) => f.startsWith("/") && !/\.\w+$/.test(f))] };
}

/* ---------------- matchers ---------------- */

/** Feature of a source file: src/modules/<feature>/… or a page under src/app. */
function fromCode(file: string, mods: Map<string, ModuleEntry>): ModuleEntry | null {
  const p = file.replace(/\\/g, "/");
  const mod = p.match(/(?:^|\/)src\/modules\/(.+)$/);
  if (mod) {
    const id = featureOf(mod[1]);
    return id && !INFRA_MODULES.has(id) ? (mods.get(id) ?? null) : null;
  }
  const app = p.match(/(?:^|\/)src\/app\/(.+)$/);
  if (app) {
    const dir = path.posix.dirname(app[1]);
    const route = segs(dir === "." ? "" : dir)
      .filter((s) => s !== "[locale]" && s !== "[namespace]" && !/^\(.*\)$/.test(s))
      .map((s) => (s.startsWith("[") ? `:${s.replace(/[[\].]/g, "")}` : s));
    return fromRoute(route, mods, 0);
  }
  return null;
}

/** Test file or pytest node id → the feature it's linked to, or named for. */
function fromTest(file: string, mods: Map<string, ModuleEntry>): ModuleEntry | null {
  const p = file.replace(/\\/g, "/").split("::")[0].replace(/^\.\//, "");
  if (!/(\.(spec|setup|test)\.[jt]sx?|(^|\/)test_\w+\.py|_test\.py)$/.test(p) && !/(^|\/)tests?\//.test(p)) return null;
  const named = (names: string[]) => names.map((n) => matchName(n, mods, true)).find(Boolean) ?? null;
  // Its folder first ("tests/dashboard/billing/positive/…"): links through
  // shared endpoints can point at a busier feature.
  const parts = segs(p);
  const start = parts.findIndex((s) => s === "tests" || s === "test" || s === "e2e");
  const byFolder = named(parts.slice(start + 1, -1).reverse());
  if (byFolder) return byFolder;
  let best: { e: ModuleEntry; w: number } | null = null;
  for (const e of mods.values()) {
    for (const t of e.tests) {
      if ((p === t.file || p.endsWith(`/${t.file}`) || t.file.endsWith(`/${p}`)) && (!best || t.weight > best.w)) best = { e, w: t.weight };
    }
  }
  if (best) return best.e;
  // Not linked: its file name ("test_billing.py").
  return named([parts[parts.length - 1].replace(/\.(spec|setup|test)\.[jt]sx?$|\.py$/, "").replace(/^test_|_test$/, "")]);
}

/** Page whose route best matches these path segments (locale / namespace prefixes skipped). */
function fromRoute(actual: string[], mods: Map<string, ModuleEntry>, maxDrop = 2): ModuleEntry | null {
  let best: { e: ModuleEntry; score: number } | null = null;
  for (const e of mods.values()) {
    for (const page of e.pages) {
      const want = segs(page);
      for (let drop = 0; drop <= maxDrop && drop <= actual.length; drop++) {
        const cand = actual.slice(drop);
        if (cand.length < want.length) continue;
        let literals = 0;
        let ok = true;
        for (let i = 0; i < want.length && ok; i++) {
          if (want[i].startsWith(":") || cand[i].startsWith(":")) continue;
          if (want[i] === cand[i]) literals++;
          else ok = false;
        }
        if (!ok || !literals) continue;
        const score = literals * 4 + want.length + (cand.length === want.length ? 2 : 0) - drop;
        if (!best || score > best.score) best = { e, score };
      }
    }
  }
  return best?.e ?? null;
}

/** /gapi endpoint → the feature that calls it (exact template beats prefix). */
function fromEndpoint(endpoint: string, mods: Map<string, ModuleEntry>): ModuleEntry | null {
  const actual = segs(normEndpoint(endpoint));
  let best: { e: ModuleEntry; score: number } | null = null;
  for (const e of mods.values()) {
    for (const ep of e.endpoints) {
      const want = segs(ep);
      if (want.length > actual.length) continue;
      let score = 0;
      for (let i = 0; i < want.length && score >= 0; i++) {
        if (want[i] === actual[i]) score += 2;
        else if (want[i] === "{}") score += 1;
        else score = -1;
      }
      if (score < 0) continue;
      score = score * 2 + (want.length === actual.length ? 1 : 0);
      // Shared endpoints: prefer the feature named in the path.
      if (actual.includes(e.id)) score += 1;
      if (!best || score > best.score) best = { e, score };
    }
  }
  return best?.e ?? null;
}

function fromUrl(url: string, mods: Map<string, ModuleEntry>): ModuleEntry | null {
  let p = url;
  if (/^https?:\/\//.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  p = p.split(/[?#]/)[0].toLowerCase();
  const hit = /^\/?(gapi|api)\//.test(p) ? fromEndpoint(p, mods) : fromRoute(segs(p), mods);
  if (hit) return hit;
  // No page / endpoint: the last path word that names a feature
  // ("/manage-workspace/presets/", "/gapi/dashboard/presets/12/").
  for (const s of segs(p).reverse()) {
    if (/^\d+$|^[0-9a-f-]{18,}$/.test(s)) continue;
    const e = matchName(s, mods, true);
    if (e) return e;
  }
  return null;
}

/* ---------------- names ---------------- */

const slug = (s: string) =>
  s
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/^-+|-+$/g, "");
const singular = (s: string) => s.replace(/(?<=\w{3})(ies)$/, "y").replace(/(?<=\w{3})s$/, "");
const words = (s: string) => slug(s).split(/[-/]+/).filter(Boolean).map(singular);
const titleCase = (s: string) => s.trim().replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Feature for a name like "Billing", "presets", "floor plan". strict: no loose token matches. */
function matchName(name: string, mods: Map<string, ModuleEntry>, strict = false): ModuleEntry | null {
  const s = slug(name);
  if (!s) return null;
  const all = [...mods.values()];
  const one = (pred: (e: ModuleEntry) => boolean) => all.find(pred) ?? null;
  const sw = words(name).join("-");
  return (
    one((e) => e.id === s) ??
    one((e) => slug(e.label) === s) ??
    one((e) => words(e.id).join("-") === sw) ??
    one((e) => words(e.id.split("/").pop()!).join("-") === sw) ??
    one((e) => words(e.label.replace(/^Editor · /, "")).join("-") === sw) ??
    (strict
      ? null
      : one((e) => {
          const have = new Set([...words(e.id), ...words(e.label)]);
          return words(name).every((w) => have.has(w));
        }))
  );
}

/* ---------------- contract ---------------- */

const planned = new Map<string, FlowModule[]>();

const dropPlanned = (term: string, m: FlowModule) => {
  const list = planned.get(term);
  if (list) planned.set(term, list.filter((p) => p.id !== m.id));
};

/** Best module for a step, most specific first; null = inherit previous step's. */
export function resolveModule(
  term: string,
  node: GraphNode,
  raw: { toolName?: string; toolInput?: Record<string, unknown>; toolResponse?: unknown },
): FlowModule | null {
  const mods = modules();
  if (!mods.size) return null;
  const { files, urls } = candidates(node, raw);
  const cwd = termCwd(term);
  const abs = files.map((f) => (cwd && !path.isAbsolute(f) && !f.startsWith("~") ? path.resolve(cwd, f.split("::")[0]) + (f.includes("::") ? f.slice(f.indexOf("::")) : "") : f));
  const hit =
    [...files, ...abs].map((f) => fromCode(f, mods)).find(Boolean) ??
    files.map((f) => fromTest(f, mods)).find(Boolean) ??
    urls.map((u) => fromUrl(u, mods)).find(Boolean) ??
    null;
  if (!hit) return null;
  const m = toModule(hit);
  dropPlanned(term, m);
  return m;
}

/** Agent-declared module ("now testing: Billing") + planned next modules. */
export function declareModule(term: string, module: string, next?: string[]): FlowModule | null {
  const mods = modules();
  const named = (name: string): FlowModule | null => {
    const e = matchName(name, mods);
    if (e) return toModule(e);
    const id = slug(name);
    return id ? { id, label: titleCase(name) } : null;
  };
  const m = named(module);
  if (next) {
    const list = next.map(named).filter((x): x is FlowModule => !!x && x.id !== m?.id);
    planned.set(term, list.filter((x, i) => list.findIndex((y) => y.id === x.id) === i));
  } else if (m) dropPlanned(term, m);
  return m;
}

export function plannedModules(term: string): FlowModule[] {
  return planned.get(term) ?? [];
}

export function forgetTerm(term: string): void {
  planned.delete(term);
}
