import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { buildTree, walk, type RepoTree } from "./tree.js";

/**
 * Cross-repo connection graph: docs sections ↔ e2e dirs ↔ api dirs.
 * Two kinds of edges:
 *  - endpoint: both test suites exercise the same (normalized) API path
 *  - topic: a docs section and a test dir share meaningful name tokens
 */

export interface HubNode {
  dir: string;
  label: string;
  files: number;
  tests?: number;
  items?: string[]; // member file/page paths (relative to repo root)
}

export interface TopicLink {
  from: [string, string]; // [repoKey, dir]
  to: [string, string];
  via: string[];
  weight: number;
}

export interface EndpointLink {
  path: string;
  e2e: string[]; // dirs
  api: string[];
}

export interface FeatureLink {
  key: string;
  label: string;
  description: string;
  e2e: string[];
  api: string[];
}

export interface Connections {
  nodes: Record<string, HubNode[]>;
  topicLinks: TopicLink[];
  endpointLinks: EndpointLink[];
  featureLinks: FeatureLink[];
}

/* ---------------- endpoint extraction ---------------- */

const CALL_RE =
  /(?:request|apiContext|api|client|session|requests|httpx?|self\.client)\s*\.\s*(?:get|post|put|patch|delete|head|options|request|goto|fetch)\s*\(\s*(?:f?["'`])([^"'`\n]{2,200})["'`]/g;
const QUOTED_PATH_RE = /(?:f?["'`])(\/(?:[a-zA-Z0-9_\-{}$:.*]+\/)*[a-zA-Z0-9_\-{}$:.*]+\/?)["'`]/g;

function normalizeEndpoint(raw: string): string | null {
  let p = raw.trim();
  if (/^https?:\/\//.test(p)) {
    try {
      p = new URL(p.replace(/\$\{[^}]*\}/g, "x").replace(/\{[^}]*\}/g, "x")).pathname;
    } catch {
      return null;
    }
  }
  if (!p.startsWith("/")) return null;
  p = p.split(/[?#]/)[0];
  const segments = p.split("/").filter(Boolean);
  if (segments.length < 2 || segments.length > 10) return null;
  const normalized = segments.map((segment) => {
    if (/\$\{|^\{|^:|^<|^\d+$|^[0-9a-f-]{18,}$|\*/.test(segment)) return "*";
    if (!/^[a-zA-Z0-9_.-]+$/.test(segment)) return null;
    return segment.toLowerCase();
  });
  if (normalized.includes(null)) return null;
  // Paths that are all wildcards tell us nothing.
  if (normalized.every((segment) => segment === "*")) return null;
  // Skip obvious non-API paths (static assets, source files).
  const last = normalized[normalized.length - 1]!;
  if (/\.(png|jpg|svg|css|js|ts|py|md|json|ico|woff2?)$/.test(last)) return null;
  return "/" + normalized.join("/");
}

function extractFileEndpoints(source: string): Set<string> {
  const found = new Set<string>();
  for (const re of [CALL_RE, QUOTED_PATH_RE]) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      const normalized = normalizeEndpoint(match[1]);
      if (normalized) found.add(normalized);
      if (found.size > 60) return found;
    }
  }
  return found;
}

/* ---------------- topic tokens ---------------- */

const STOPWORDS = new Set([
  "test", "tests", "spec", "specs", "setup", "index", "docs", "doc", "use", "cases", "case",
  "src", "main", "data", "page", "pages", "file", "files", "common", "utils", "util", "helpers",
  "the", "and", "for", "with", "api", "e2e", "basic", "new", "get", "set", "misc", "core",
  "resources", "contracts", "fixtures", "conftest", "config",
]);

const SYNONYMS: Record<string, string> = {
  authentication: "auth", login: "auth", signin: "auth", logins: "auth",
  cameras: "camera", camerareturns: "return", returns: "return", returned: "return",
  payments: "billing", payment: "billing", invoices: "billing", invoice: "billing",
  subscriptions: "billing", subscription: "billing", checkout: "ecommerce", shop: "ecommerce",
  store: "ecommerce", orders: "order", analytic: "analytics", stats: "analytics",
  projects: "project", editors: "editor", editing: "editor", edit: "editor",
  users: "user", accounts: "account", members: "member", teams: "team",
  workspaces: "workspace", leads: "lead", tours: "tour", virtualtour: "tour",
  dashboards: "dashboard", uploads: "upload", uploading: "upload", downloads: "download",
  webhooks: "webhook", shipments: "shipment", shipping: "shipment", portals: "portal",
};

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (let raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 3) continue;
    raw = SYNONYMS[raw] ?? raw;
    if (raw.endsWith("s") && raw.length > 4) raw = SYNONYMS[raw.slice(0, -1)] ?? raw.slice(0, -1);
    raw = SYNONYMS[raw] ?? raw;
    if (!STOPWORDS.has(raw) && !/^\d+$/.test(raw)) tokens.add(raw);
  }
  return tokens;
}

/* ---------------- graph assembly ---------------- */

function dirOf(filePath: string): string {
  const segments = filePath.split("/");
  return segments.slice(0, Math.min(2, segments.length - 1)).join("/") || "(root)";
}

function testDirInfo(tree: RepoTree) {
  const dirs = new Map<string, { files: string[]; tests: number; endpoints: Set<string>; tokens: Set<string> }>();
  const repo = config.repos[tree.key];
  for (const file of tree.files) {
    const dir = dirOf(file.path);
    const entry = dirs.get(dir) ?? { files: [], tests: 0, endpoints: new Set(), tokens: new Set() };
    entry.files.push(file.path);
    entry.tests += file.tests.length;
    for (const token of tokenize(file.path)) entry.tokens.add(token);
    try {
      const source = fs.readFileSync(path.join(repo.path, file.path), "utf8");
      for (const endpoint of extractFileEndpoints(source)) entry.endpoints.add(endpoint);
    } catch {
      /* unreadable file */
    }
    dirs.set(dir, entry);
  }
  for (const [dir, entry] of dirs) for (const token of tokenize(dir)) entry.tokens.add(token);
  return dirs;
}

function docsSections(docsKey: string) {
  const repo = config.repos[docsKey];
  const docsRoot = path.join(repo.path, "docs");
  const sections = new Map<string, { pages: string[]; tokens: Set<string> }>();
  if (!fs.existsSync(docsRoot)) return sections;
  for (const abs of walk(docsRoot, docsRoot)) {
    if (!abs.endsWith(".md")) continue;
    const rel = path.relative(docsRoot, abs);
    if (rel.startsWith("includes/") || rel.startsWith("assets/")) continue;
    const segments = rel.split("/");
    const section = segments.slice(0, Math.min(2, Math.max(1, segments.length - 1))).join("/") || "(root)";
    const entry = sections.get(section) ?? { pages: [], tokens: new Set() };
    entry.pages.push(rel);
    for (const token of tokenize(rel)) entry.tokens.add(token);
    sections.set(section, entry);
  }
  return sections;
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const value of a) if (b.has(value)) out.push(value);
  return out;
}

function loadFeatureLinks(): FeatureLink[] {
  const featuresPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../qualitylab.features.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(featuresPath, "utf8"));
    return Array.isArray(parsed.features) ? parsed.features : [];
  } catch {
    return [];
  }
}

export function buildConnections(): Connections {
  const trees = buildTree();

  // Docs are knowledge, not nodes: the feature map (qualitylab.features.json,
  // generated by reading the product docs) carries their contribution.
  const testDirs = new Map<string, ReturnType<typeof testDirInfo>>();
  for (const tree of trees) testDirs.set(tree.key, testDirInfo(tree));

  const nodes: Record<string, HubNode[]> = {};
  for (const [key, dirs] of testDirs) {
    nodes[key] = [...dirs.entries()].map(([dir, d]) => ({
      dir,
      label: dir,
      files: d.files.length,
      tests: d.tests,
      items: d.files.slice(0, 80),
    }));
  }

  // endpoint links: same normalized path hit by both suites
  const byEndpoint = new Map<string, Record<string, Set<string>>>();
  for (const [key, dirs] of testDirs) {
    for (const [dir, info] of dirs) {
      for (const endpoint of info.endpoints) {
        const entry = byEndpoint.get(endpoint) ?? {};
        (entry[key] ??= new Set()).add(dir);
        byEndpoint.set(endpoint, entry);
      }
    }
  }
  const endpointLinks: EndpointLink[] = [...byEndpoint.entries()]
    .filter(([, repos]) => Object.keys(repos).length > 1)
    .map(([endpoint, repos]) => ({
      path: endpoint,
      e2e: [...(repos["e2e"] ?? [])],
      api: [...(repos["api"] ?? [])],
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, 60);

  // topic links: e2e dir ↔ api dir name/token overlap
  const topicLinks: TopicLink[] = [];
  const [e2ePair, apiPair] = [testDirs.get("e2e"), testDirs.get("api")];
  if (e2ePair && apiPair) {
    for (const [e2eDir, e2eInfo] of e2ePair) {
      for (const [apiDir, apiInfo] of apiPair) {
        const via = intersect(e2eInfo.tokens, apiInfo.tokens);
        if (via.length > 0) {
          topicLinks.push({ from: ["e2e", e2eDir], to: ["api", apiDir], via, weight: via.length });
        }
      }
    }
  }
  topicLinks.sort((a, b) => b.weight - a.weight);

  // feature links come from the docs-derived feature map; keep only dirs
  // that actually exist in the scanned trees.
  const featureLinks = loadFeatureLinks()
    .map((f) => ({
      ...f,
      e2e: f.e2e.filter((d) => e2ePair?.has(d)),
      api: f.api.filter((d) => apiPair?.has(d)),
    }))
    .filter((f) => f.e2e.length > 0 || f.api.length > 0);

  return { nodes, topicLinks: topicLinks.slice(0, 250), endpointLinks, featureLinks };
}
