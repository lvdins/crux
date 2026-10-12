import fs from "node:fs";
import path from "node:path";
import { config, type RepoConfig } from "./config.js";
import { walk } from "./tree.js";

/**
 * Feature map: the dashboard's feature modules are the backbone. For each
 * module we collect the pages that render it and the /gapi endpoints it
 * calls, resolve every endpoint to the web-service view that serves it, and
 * attach the API tests that hit those endpoints and the E2E tests that
 * exercise the feature (by route, endpoint, page object or folder name).
 */

/* ---------------- shared helpers ---------------- */

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** Canonical endpoint template: "gapi/dashboard/projects/{}/archive". */
export function normEndpoint(raw: string): string {
  return raw
    // A template cut off mid-expression is a query-string suffix
    // ("users${qs}") — drop it; one after a slash is a path param.
    .replace(/\/\$\{[^}]*$/, "/{}")
    .replace(/\$\{[^}]*$/, "")
    .replace(/\$\{[^}]*\}/g, "{}") // JS template params
    .replace(/\{[^}]*\}/g, "{}") // python f-string / openapi params
    .split("?")[0]
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}

const segs = (p: string) => (p ? p.split("/") : []);

const GENERIC_TOKENS = new Set(["page", "pages", "list", "root", "editor", "new", "v2", "spec", "test", "tests", "the", "and", "details", "detail", "dashboard"]);
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (let t of text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (t.length < 2) continue;
    if (t.endsWith("s") && t.length > 3 && !t.endsWith("ss")) t = t.slice(0, -1);
    out.add(t);
  }
  return out;
}

/* ---------------- dashboard (frontend) ---------------- */

interface FeEndpoint {
  path: string;
  methods: Set<string>;
  files: Set<string>;
}
interface FeFeature {
  id: string;
  module: string; // path relative to repo root
  files: number;
  endpoints: Map<string, FeEndpoint>;
  pages: Set<string>;
}

/** The Next.js app inside a repo: the repo itself or an nx app such as apps/dashboard. */
function findAppRoot(repo: string): string | null {
  const ok = (dir: string) => fs.existsSync(path.join(dir, "src", "modules")) || fs.existsSync(path.join(dir, "src", "app"));
  if (ok(repo)) return repo;
  const apps = path.join(repo, "apps");
  if (!fs.existsSync(apps)) return null;
  const preferred = path.join(apps, "dashboard");
  if (ok(preferred)) return preferred;
  for (const name of fs.readdirSync(apps)) if (ok(path.join(apps, name))) return path.join(apps, name);
  return null;
}

const CALL_RE = /\b(get|post|patch|put|del|delete|unauthenticatedGet|unauthenticatedPost|unauthenticatedPatch|unauthenticatedPut)\s*(?:<[^>()]*>)?\(\s*[`'"](\/gapi\/[^`'"?]*)/g;
const GAPI_RE = /[`'"](\/gapi\/[^`'"?]*)/g;
// Shared plumbing, not features: never the "owner" of a page.
export const INFRA_MODULES = new Set(["auth", "state-manager", "feature-flags", "notification", "external", "i18n"]);

export function featureOf(modulePath: string): string | null {
  // modulePath: "billing/components/x.tsx" or "editor/floor-plan/x.tsx"
  const parts = modulePath.split("/");
  if (parts.length < 2) return null;
  if (parts[0] === "editor") {
    return parts.length >= 3 && !/\.(ts|tsx)$/.test(parts[1]) ? `editor/${parts[1]}` : "editor/generic";
  }
  return parts[0];
}

/** Feature of an `@/modules/…` import ("help" alone means its index). */
export const featureOfImport = (imported: string) => featureOf(imported.includes("/") ? imported : `${imported}/index.ts`);

function routeOf(appDir: string, pageFile: string): string {
  const rel = path.relative(appDir, path.dirname(pageFile));
  const parts = rel
    .split(path.sep)
    .filter((p) => p && p !== "[locale]" && p !== "[namespace]" && !/^\(.*\)$/.test(p))
    .map((p) => (p.startsWith("[") ? `:${p.replace(/[[\].]/g, "")}` : p));
  return "/" + parts.join("/");
}

export function scanFrontend(repo: RepoConfig) {
  const appRoot = findAppRoot(repo.path);
  const features = new Map<string, FeFeature>();
  if (!appRoot) return { features, appRoot: null as string | null };
  const modulesDir = path.join(appRoot, "src", "modules");
  const get = (id: string) => {
    let f = features.get(id);
    if (!f) {
      const module = path.relative(repo.path, path.join(modulesDir, id));
      f = { id, module, files: 0, endpoints: new Map(), pages: new Set() };
      features.set(id, f);
    }
    return f;
  };
  const addEndpoints = (f: FeFeature, source: string, relFile: string) => {
    const methodByPath = new Map<string, string>();
    for (const m of source.matchAll(CALL_RE)) {
      const verb = m[1].replace(/^unauthenticated/, "").toUpperCase().replace("DEL", "DELETE").replace("DELETEETE", "DELETE");
      methodByPath.set(normEndpoint(m[2]), verb);
    }
    for (const m of source.matchAll(GAPI_RE)) {
      const p = normEndpoint(m[1]);
      if (segs(p).length < 3) continue; // bare "gapi/dashboard"
      const e = f.endpoints.get(p) ?? { path: p, methods: new Set(), files: new Set() };
      const verb = methodByPath.get(p);
      if (verb) e.methods.add(verb);
      e.files.add(relFile);
      f.endpoints.set(p, e);
    }
  };

  if (fs.existsSync(modulesDir)) {
    for (const abs of walk(modulesDir, modulesDir)) {
      if (!/\.(ts|tsx)$/.test(abs) || /(\.test\.|\.spec\.|__test__|__mocks__|\.stories\.)/.test(abs)) continue;
      const id = featureOf(path.relative(modulesDir, abs));
      if (!id || INFRA_MODULES.has(id)) continue;
      const f = get(id);
      f.files++;
      addEndpoints(f, read(abs), path.relative(repo.path, abs));
    }
  }

  const appDir = path.join(appRoot, "src", "app");
  if (fs.existsSync(appDir)) {
    for (const abs of walk(appDir, appDir)) {
      if (!/\/page\.tsx?$/.test(abs)) continue;
      const source = read(abs);
      const owners = [...source.matchAll(/from\s+['"]@\/modules\/([^'"]+)['"]/g)]
        .map((m) => featureOfImport(m[1]))
        .filter((id): id is string => !!id && !INFRA_MODULES.has(id));
      if (owners.length === 0) continue;
      // The most-imported module is the page's feature.
      const counts = new Map<string, number>();
      for (const o of owners) counts.set(o, (counts.get(o) ?? 0) + 1);
      const owner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const f = get(owner);
      f.pages.add(routeOf(appDir, abs));
      addEndpoints(f, source, path.relative(repo.path, abs));
    }
  }
  for (const [id, f] of features) if (f.files === 0 && f.pages.size === 0) features.delete(id);
  return { features, appRoot };
}

/* ---------------- web-service (Django backend) ---------------- */

interface BeRoute {
  pattern: string[]; // normalized segments, "{}" for params
  router: boolean; // DRF router prefix: also serves {id} and @action suffixes
  view: string;
  file?: string;
  line?: number;
}

/** Replace regex groups "(?P<x>...)" (balanced) and "<int:x>" with {}. */
function normPattern(raw: string): string {
  const s = raw.replace(/^r?['"]|['"]$/g, "").replace(/^\^/, "").replace(/\$$/, "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === "\\") j++;
        else if (s[j] === "(") depth++;
        else if (s[j] === ")") depth--;
        j++;
      }
      out += "{}";
      i = j - 1;
    } else out += s[i];
  }
  return out.replace(/<[^>]+>/g, "{}").replace(/\\\./g, ".").replace(/\$$/, "").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function parseImports(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^from\s+([\w.]+)\s+import\s+(\([\s\S]*?\)|[^\n]+)/gm;
  for (const m of source.matchAll(re)) {
    const names = m[2].replace(/[()]/g, "").split(",");
    for (const n of names) {
      const parts = n.trim().split(/\s+as\s+/);
      if (!parts[0]) continue;
      map.set((parts[1] ?? parts[0]).trim(), m[1]);
    }
  }
  return map;
}

function moduleFile(root: string, mod: string): string | undefined {
  const base = path.join(root, ...mod.split("."));
  if (fs.existsSync(base + ".py")) return base + ".py";
  if (fs.existsSync(path.join(base, "__init__.py"))) return path.join(base, "__init__.py");
  return undefined;
}

export function scanBackend(repo: RepoConfig): BeRoute[] {
  const root = repo.path;
  const routes: BeRoute[] = [];
  const settings = read(path.join(root, "app", "settings.py"));
  const rootConf = settings.match(/ROOT_URLCONF\s*=\s*['"]([\w.]+)['"]/)?.[1] ?? "app.urls";
  const seen = new Set<string>();
  const classLine = new Map<string, number | undefined>();

  const locate = (view: string, imports: Map<string, string>) => {
    const name = view.split(".").pop()!;
    const head = view.includes(".") ? view.split(".")[0] : name;
    const mod = imports.get(head);
    let file = mod ? moduleFile(root, mod) : undefined;
    if (file && view.includes(".")) {
      // "views.Foo" → module "pkg.views"
      file = moduleFile(root, `${mod}.${head}`) ?? file;
    }
    if (!file) return { file: undefined, line: undefined };
    const key = `${file}#${name}`;
    if (!classLine.has(key)) {
      const idx = read(file).split("\n").findIndex((l) => new RegExp(`^class\\s+${name}\\b`).test(l));
      classLine.set(key, idx >= 0 ? idx + 1 : undefined);
    }
    return { file: path.relative(root, file), line: classLine.get(key) };
  };

  const visit = (mod: string, prefix: string, depth: number) => {
    const file = moduleFile(root, mod);
    if (!file || seen.has(file + prefix) || depth > 6) return;
    seen.add(file + prefix);
    const source = read(file);
    const imports = parseImports(source);
    const join = (p: string) => [prefix, normPattern(p)].filter(Boolean).join("/");

    for (const m of source.matchAll(/\.register\(\s*(r?['"][^'"]*['"])\s*,\s*([\w.]+)/g)) {
      routes.push({ pattern: segs(join(m[1])), router: true, view: m[2].split(".").pop()!, ...locate(m[2], imports) });
    }
    for (const m of source.matchAll(/\b(?:re_)?path\(\s*(r?['"][^'"]*['"])\s*,\s*([^\n]+)/g)) {
      const target = m[2];
      const inc = target.match(/include\(\s*\(?\s*['"]([\w.]+)['"]/);
      if (inc) {
        visit(inc[1], join(m[1]), depth + 1);
        continue;
      }
      const view = target.match(/([\w.]+)\.as_view\(/)?.[1] ?? target.match(/^([\w.]+)\s*[,)]/)?.[1];
      if (view && !/include|router/.test(view)) {
        routes.push({ pattern: segs(join(m[1])), router: false, view: view.split(".").pop()!, ...locate(view, imports) });
      }
    }
  };
  visit(rootConf, "", 0);
  return routes;
}

export function resolveBackend(endpoint: string, routes: BeRoute[]): BeRoute | undefined {
  const e = segs(endpoint);
  let best: { r: BeRoute; score: number } | undefined;
  for (const r of routes) {
    const p = r.pattern;
    if (p.length > e.length) continue;
    const extra = e.length - p.length;
    if (r.router ? extra > 3 : extra !== 0) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === e[i]) score += 2;
      else if (p[i] === "{}" || e[i] === "{}") score += 1;
      else {
        ok = false;
        break;
      }
    }
    if (ok && (!best || score > best.score || (score === best.score && !r.router))) best = { r, score };
  }
  return best?.r;
}

/* ---------------- API tests (pytest + route classes) ---------------- */

interface ApiFile {
  path: string;
  tests: number;
  endpoints: Set<string>;
}

function scanApiTests(repo: RepoConfig): ApiFile[] {
  const root = repo.path;
  const constants = new Map<string, string>();
  const members = new Map<string, string>(); // "Class.member" → endpoint template
  const pyFiles: string[] = [];
  for (const abs of walk(root, root)) if (abs.endsWith(".py")) pyFiles.push(abs);

  const expand = (tpl: string): string =>
    tpl.replace(/\{([^}]*)\}/g, (_, expr: string) => {
      const name = expr.trim();
      return constants.has(name) ? constants.get(name)! : "{}";
    });

  // Pass 1: module-level string constants (GAPI = "gapi", DASHBOARD = f"{GAPI}/dashboard").
  for (let pass = 0; pass < 3; pass++) {
    for (const abs of pyFiles) {
      if (/\/tests?\//.test(abs)) continue;
      for (const m of read(abs).matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*f?["']([^"']*)["']/gm)) {
        constants.set(m[1], expand(m[2]));
      }
    }
  }
  // Pass 2: route classes — members and staticmethods returning f-strings.
  for (const abs of pyFiles) {
    if (/\/tests?\//.test(abs)) continue;
    const lines = read(abs).split("\n");
    let cls: string | null = null;
    let method: string | null = null;
    for (const line of lines) {
      const c = line.match(/^class\s+(\w+)/);
      if (c) {
        cls = c[1];
        method = null;
        continue;
      }
      if (!cls) continue;
      if (/^\S/.test(line) && line.trim()) {
        cls = null;
        continue;
      }
      const attr = line.match(/^\s{4}([A-Za-z_]\w*)\s*=\s*f?["']([^"']+)["']/);
      if (attr) {
        const v = normEndpoint(expand(attr[2]));
        if (v.startsWith("gapi/") || v.startsWith("api/")) members.set(`${cls}.${attr[1]}`, v);
        continue;
      }
      const def = line.match(/^\s{4}def\s+(\w+)/);
      if (def) {
        method = def[1];
        continue;
      }
      const ret = method && line.match(/return\s+f?["']([^"']+)["']/);
      if (ret && method) {
        const v = normEndpoint(expand(ret[1]));
        if (v.startsWith("gapi/") || v.startsWith("api/")) members.set(`${cls}.${method}`, v);
      }
    }
  }
  const classNames = [...new Set([...members.keys()].map((k) => k.split(".")[0]))];
  const useRe = classNames.length ? new RegExp(`\\b(${classNames.join("|")})\\.(\\w+)`, "g") : null;

  const files: ApiFile[] = [];
  const byDir = new Map<string, Set<string>>(); // conftest endpoints apply to their folder
  for (const abs of pyFiles) {
    const rel = path.relative(root, abs);
    const name = path.basename(abs);
    const isTest = /^test_.*\.py$/.test(name);
    if (!isTest && name !== "conftest.py") continue;
    const source = read(abs);
    const endpoints = new Set<string>();
    if (useRe) for (const m of source.matchAll(useRe)) {
      const v = members.get(`${m[1]}.${m[2]}`);
      if (v) endpoints.add(v);
    }
    for (const m of source.matchAll(/f?["'](\/?gapi\/[^"'?]*)/g)) endpoints.add(normEndpoint(expand(m[1])));
    if (name === "conftest.py") {
      byDir.set(path.dirname(rel), endpoints);
      continue;
    }
    const tests = (source.match(/^\s*(?:async\s+)?def\s+test_\w+/gm) ?? []).length;
    files.push({ path: rel, tests, endpoints });
  }
  for (const f of files) {
    for (const [dir, eps] of byDir) {
      // Only the conftest beside the test: ancestor conftests hold shared
      // setup (auth, workspaces) and would link every test to everything.
      if (dir === path.dirname(f.path)) for (const e of eps) f.endpoints.add(e);
    }
  }
  return files;
}

/* ---------------- E2E tests (Playwright) ---------------- */

interface E2eFile {
  path: string;
  tests: number;
  routes: Set<string>;
  endpoints: Set<string>;
  tokens: Set<string>;
  pageObjects: string[];
}

function scanE2e(repo: RepoConfig): E2eFile[] {
  const root = repo.path;
  const out: E2eFile[] = [];
  for (const abs of walk(path.join(root, "tests"), root)) {
    if (!/\.(spec|setup)\.ts$/.test(abs)) continue;
    const rel = path.relative(root, abs);
    const source = read(abs);
    const routes = new Set<string>();
    for (const m of source.matchAll(/goto\(\s*[`'"]([^`'"]*)/g)) {
      const r = m[1]
        .replace(/^https?:\/\/[^/]+/, "")
        .replace(/\$\{\s*baseURL\s*\}\/?/, "/")
        .replace(/\$\{[^}]*\}/g, ":p")
        .split("?")[0]
        .replace(/\/+$/, "");
      if (r && r !== "/") routes.add(r.startsWith("/") ? r : `/${r}`);
    }
    const endpoints = new Set<string>();
    for (const m of source.matchAll(/[`'"](\/?gapi\/[^`'"?]*)/g)) endpoints.add(normEndpoint(m[1]));
    const pageObjects = [...source.matchAll(/import\s+[^;]*?from\s+['"][./]*pages\/[^'"]*\/(\w+)['"]/g)].map((m) => m[1]);
    const tok = tokens(path.dirname(rel).replace(/^tests\/?/, ""));
    for (const po of pageObjects) for (const t of tokens(po)) tok.add(t);
    for (const t of tokens(path.basename(rel).replace(/\.(spec|setup)\.ts$/, ""))) tok.add(t);
    const tests = (source.match(/^\s*test(?:\.(?:only|fixme|skip))?\s*\(/gm) ?? []).length;
    out.push({ path: rel, tests, routes, endpoints, tokens: tok, pageObjects });
  }
  return out;
}

function routeMatches(pageRoute: string, visited: string): boolean {
  const a = segs(pageRoute.replace(/^\/+/, ""));
  const b = segs(visited.replace(/^\/+/, ""));
  // e2e paths sometimes keep the namespace: "/:p/projects/:p"
  for (const cand of [b, b.slice(1)]) {
    if (cand.length !== a.length) continue;
    if (a.every((s, i) => s === cand[i] || s.startsWith(":") || cand[i] === ":p")) return true;
  }
  return false;
}

/* ---------------- assembly ---------------- */

export interface FeatureEndpoint {
  path: string;
  methods: string[];
  backend?: { view: string; file?: string; line?: number };
  apiTests: string[];
  e2eTests: string[];
}
export interface FeatureLink {
  file: string;
  tests: number;
  via: string[];
}
export interface Feature {
  id: string;
  label: string;
  group: string;
  module: string;
  files: number;
  pages: { route: string; e2e: string[] }[];
  endpoints: FeatureEndpoint[];
  e2e: FeatureLink[];
  api: FeatureLink[];
  coverage: { endpoints: number; apiCovered: number; backendResolved: number; e2eTests: number; apiTests: number };
}
export interface FeatureMap {
  ready: boolean;
  missing: string[];
  sources: Record<string, { key: string; label: string; path: string } | null>;
  features: Feature[];
  totals: { features: number; endpoints: number; apiCovered: number; noE2e: number; noApi: number };
  builtAt: string;
  ms: number;
}

const LABELS: Record<string, string> = {
  "editor/ai-fp": "Editor · AI floor plan",
  "editor/ai-image": "Editor · AI image",
  "editor/ai-image-new": "Editor · AI image (new)",
  "editor/floor-plan-v2": "Editor · Floor plan v2",
  "editor/panorama-v2": "Editor · Panorama v2",
  "onboarding-v2": "Onboarding",
};
export function labelOf(id: string): string {
  if (LABELS[id]) return LABELS[id];
  const pretty = (s: string) => s.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return id.startsWith("editor/") ? `Editor · ${pretty(id.slice(7))}` : pretty(id);
}

export function firstOfKind(kind: string): [string, RepoConfig] | null {
  const hit = Object.entries(config.repos).find(([, r]) => r.kind === kind && fs.existsSync(r.path));
  return hit ?? null;
}

export function buildFeatureMap(): FeatureMap {
  const started = Date.now();
  const fe = firstOfKind("frontend");
  const be = firstOfKind("backend");
  const e2e = firstOfKind("playwright");
  const api = firstOfKind("pytest");
  const src = (x: [string, RepoConfig] | null) => (x ? { key: x[0], label: x[1].label, path: x[1].path } : null);
  const sources = { dashboard: src(fe), backend: src(be), e2e: src(e2e), api: src(api) };
  const missing = Object.entries(sources)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const empty = { features: 0, endpoints: 0, apiCovered: 0, noE2e: 0, noApi: 0 };
  if (!fe) return { ready: false, missing, sources, features: [], totals: empty, builtAt: new Date().toISOString(), ms: 0 };

  const { features: feFeatures } = scanFrontend(fe[1]);
  const beRoutes = be ? scanBackend(be[1]) : [];
  const apiFiles = api ? scanApiTests(api[1]) : [];
  const e2eFiles = e2e ? scanE2e(e2e[1]) : [];

  // endpoint → api test files
  const apiByEndpoint = new Map<string, string[]>();
  for (const f of apiFiles) for (const ep of f.endpoints) (apiByEndpoint.get(ep) ?? apiByEndpoint.set(ep, []).get(ep)!).push(f.path);
  const apiTestCount = new Map(apiFiles.map((f) => [f.path, f.tests]));

  const features: Feature[] = [];
  for (const f of feFeatures.values()) {
    const featTokens = new Set([...tokens(f.id)].filter((t) => !GENERIC_TOKENS.has(t)));
    const isEditor = f.id.startsWith("editor/");

    const e2eLinks = new Map<string, FeatureLink>();
    const link = (file: E2eFile, why: string) => {
      const l = e2eLinks.get(file.path) ?? { file: file.path, tests: file.tests, via: [] };
      if (!l.via.includes(why)) l.via.push(why);
      e2eLinks.set(file.path, l);
    };
    const pages = [...f.pages].sort().map((route) => ({ route, e2e: [] as string[] }));
    for (const file of e2eFiles) {
      for (const page of pages) {
        for (const visited of file.routes) {
          if (routeMatches(page.route, visited)) {
            link(file, `opens ${page.route}`);
            if (!page.e2e.includes(file.path)) page.e2e.push(file.path);
          }
        }
      }
      for (const ep of file.endpoints) if (f.endpoints.has(ep)) link(file, `calls /${ep}`);
      // Name evidence: every distinctive feature token appears in the test's
      // folder / file / page-object names (and editors need "editor" too).
      if (featTokens.size > 0 && [...featTokens].every((t) => file.tokens.has(t)) && (!isEditor || file.tokens.has("editor"))) {
        const po = file.pageObjects.find((p) => [...featTokens].every((t) => tokens(p).has(t)));
        link(file, po ? `uses ${po}` : `named for ${f.id}`);
      }
    }

    const endpoints: FeatureEndpoint[] = [...f.endpoints.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((ep) => {
        const r = beRoutes.length ? resolveBackend(ep.path, beRoutes) : undefined;
        return {
          path: ep.path,
          methods: [...ep.methods].sort(),
          backend: r ? { view: r.view, file: r.file, line: r.line } : undefined,
          apiTests: apiByEndpoint.get(ep.path) ?? [],
          e2eTests: e2eFiles.filter((x) => x.endpoints.has(ep.path)).map((x) => x.path),
        };
      });

    const apiLinks = new Map<string, FeatureLink>();
    for (const ep of endpoints) {
      for (const file of ep.apiTests) {
        const l = apiLinks.get(file) ?? { file, tests: apiTestCount.get(file) ?? 0, via: [] };
        l.via.push(`/${ep.path}`);
        apiLinks.set(file, l);
      }
    }

    const e2eList = [...e2eLinks.values()].sort((a, b) => b.via.length - a.via.length || a.file.localeCompare(b.file));
    const apiList = [...apiLinks.values()].sort((a, b) => b.via.length - a.via.length || a.file.localeCompare(b.file));
    features.push({
      id: f.id,
      label: labelOf(f.id),
      group: isEditor ? "Editors" : "Dashboard",
      module: f.module,
      files: f.files,
      pages,
      endpoints,
      e2e: e2eList,
      api: apiList,
      coverage: {
        endpoints: endpoints.length,
        apiCovered: endpoints.filter((e) => e.apiTests.length > 0).length,
        backendResolved: endpoints.filter((e) => e.backend).length,
        e2eTests: e2eList.reduce((n, l) => n + l.tests, 0),
        apiTests: apiList.reduce((n, l) => n + l.tests, 0),
      },
    });
  }
  features.sort((a, b) => a.group.localeCompare(b.group) || b.coverage.endpoints - a.coverage.endpoints);

  const totals = {
    features: features.length,
    endpoints: features.reduce((n, f) => n + f.coverage.endpoints, 0),
    apiCovered: features.reduce((n, f) => n + f.coverage.apiCovered, 0),
    noE2e: features.filter((f) => f.e2e.length === 0).length,
    noApi: features.filter((f) => f.coverage.endpoints > 0 && f.coverage.apiCovered === 0).length,
  };
  return { ready: true, missing, sources, features, totals, builtAt: new Date().toISOString(), ms: Date.now() - started };
}
