import fs from "node:fs";
import path from "node:path";
import { walk } from "./tree.js";
import { featureOf, featureOfImport, firstOfKind, INFRA_MODULES, labelOf, resolveBackend, scanBackend, scanFrontend } from "./features.js";

/**
 * Connections graph: how the dashboard's features hang together, read from
 * the frontend and backend repos (no tests, no endpoint lists).
 * - "code": feature A imports components / logic from feature B's module.
 * - "data": A and B call backend views that use the same Django models
 *   (models nearly every feature touches, like Workspace, don't count).
 */

export interface GraphFeature {
  id: string;
  label: string;
  group: string;
  module: string;
  files: number;
  pages: string[];
  /** Django models this feature's backend views use, by model file area. */
  models: { name: string; area: string }[];
  /** Models almost every feature uses: listed, not linked. */
  common: string[];
  /** A few shared files with no pages of their own (not a full feature). */
  helper: boolean;
}
export interface GraphLink {
  /** For "code": from uses to. For "data": unordered. */
  from: string;
  to: string;
  kind: "code" | "data";
  weight: number;
  /** code: imported paths; data: shared model names. */
  why: string[];
}
export interface FeatureGraphData {
  ready: boolean;
  missing: string[];
  features: GraphFeature[];
  links: GraphLink[];
  /** Modules nothing imports, with no pages or data (dead code): left off the graph. */
  unused: string[];
  builtAt: string;
  ms: number;
}

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** Django model classes in the backend: name → area ("project_models.py" → "Project"). */
export function backendModels(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const dirs = [path.join(root, "core", "models")];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const abs of walk(dir, dir)) {
      if (!abs.endsWith(".py")) continue;
      const area = path
        .basename(abs, ".py")
        .replace(/_models?$/, "")
        .replace(/_/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase());
      for (const m of read(abs).matchAll(/^class\s+(\w+)\s*\(([^)]*)\)/gm)) {
        // Models, not mixins / querysets / enums.
        if (/Model|Base|Preset|TimeStamped/.test(m[2]) && !/(QuerySet|Manager|Choices|Enum|Mixin|Meta)$/.test(m[1])) out.set(m[1], area);
      }
    }
  }
  return out;
}

/** Source of top-level class `name` in a Python file (up to the next top-level statement). */
function classBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^class\\s+${name}\\b`, "m"));
  if (start < 0) return "";
  const rest = source.slice(start);
  const nl = rest.indexOf("\n");
  if (nl < 0) return rest;
  // Next line that starts at column 0 (decorators / blank lines don't count).
  const end = rest.slice(nl + 1).search(/^[^\s#@)]/m);
  return end < 0 ? rest : rest.slice(0, nl + 1 + end);
}

/** Models a view uses: named in its class, or in serializers it references (same file). */
export function viewModels(file: string, view: string, models: Map<string, string>, cache: Map<string, Set<string>>): Set<string> {
  const key = `${file}#${view}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const source = read(file);
  const found = new Set<string>();
  const scan = (text: string) => {
    for (const w of text.match(/\b[A-Z]\w+\b/g) ?? []) if (models.has(w)) found.add(w);
  };
  const body = classBody(source, view);
  scan(body);
  for (const s of new Set(body.match(/\b\w+Serializer\b/g) ?? [])) scan(classBody(source, s));
  cache.set(key, found);
  return found;
}

export function buildFeatureGraph(): FeatureGraphData {
  const started = Date.now();
  const fe = firstOfKind("frontend");
  const be = firstOfKind("backend");
  const missing = [!fe && "dashboard", !be && "backend"].filter(Boolean) as string[];
  if (!fe) return { ready: false, missing, features: [], links: [], unused: [], builtAt: new Date().toISOString(), ms: 0 };

  const { features: feFeatures, appRoot } = scanFrontend(fe[1]);
  const routes = be ? scanBackend(be[1]) : [];
  const models = be ? backendModels(be[1].path) : new Map<string, string>();
  const cache = new Map<string, Set<string>>();

  // feature → models its views use
  const usesModels = new Map<string, Set<string>>();
  for (const f of feFeatures.values()) {
    const set = new Set<string>();
    for (const ep of f.endpoints.values()) {
      const r = routes.length ? resolveBackend(ep.path, routes) : undefined;
      if (r?.file && be) for (const m of viewModels(path.join(be[1].path, r.file), r.view, models, cache)) set.add(m);
    }
    usesModels.set(f.id, set);
  }
  // Models used by most features (Workspace, User…) would link everything.
  const counts = new Map<string, number>();
  for (const set of usesModels.values()) for (const m of set) counts.set(m, (counts.get(m) ?? 0) + 1);
  const withData = [...usesModels.values()].filter((s) => s.size).length;
  const common = new Set([...counts].filter(([, n]) => n > Math.max(3, withData * 0.3)).map(([m]) => m));

  // feature → feature imports (code): from module files, and from pages (as their owning feature).
  const code = new Map<string, Map<string, string[]>>();
  const addCode = (from: string, imported: string) => {
    const to = featureOfImport(imported);
    if (!to || to === from || INFRA_MODULES.has(to) || !feFeatures.has(to)) return;
    const targets = code.get(from) ?? code.set(from, new Map()).get(from)!;
    (targets.get(to) ?? targets.set(to, []).get(to)!).push(imported);
  };
  const importsOf = (source: string) => [...source.matchAll(/from\s+['"]@\/modules\/([^'"]+)['"]/g)].map((m) => m[1]);
  const modulesDir = appRoot ? path.join(appRoot, "src", "modules") : null;
  if (modulesDir && fs.existsSync(modulesDir)) {
    for (const abs of walk(modulesDir, modulesDir)) {
      if (!/\.(ts|tsx)$/.test(abs) || /(\.test\.|\.spec\.|__mocks__|\.stories\.)/.test(abs)) continue;
      const from = featureOf(path.relative(modulesDir, abs));
      if (!from || !feFeatures.has(from)) continue;
      for (const imported of importsOf(read(abs))) addCode(from, imported);
    }
  }
  // A page belongs to the feature it imports most (same rule as scanFrontend).
  const appDir = appRoot ? path.join(appRoot, "src", "app") : null;
  if (appDir && fs.existsSync(appDir)) {
    for (const abs of walk(appDir, appDir)) {
      if (!/\/page\.tsx?$/.test(abs)) continue;
      const imported = importsOf(read(abs));
      const counts = new Map<string, number>();
      for (const i of imported) {
        const id = featureOfImport(i);
        if (id && !INFRA_MODULES.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      if (!counts.size) continue;
      const owner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (feFeatures.has(owner)) for (const i of imported) addCode(owner, i);
    }
  }

  const links: GraphLink[] = [];
  for (const [from, targets] of code) {
    for (const [to, paths] of targets) {
      const top = [...paths.reduce((acc, p) => acc.set(p, (acc.get(p) ?? 0) + 1), new Map<string, number>())]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([p]) => p);
      links.push({ from, to, kind: "code", weight: paths.length, why: top });
    }
  }
  const ids = [...feFeatures.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = usesModels.get(ids[i])!;
      const shared = [...usesModels.get(ids[j])!].filter((m) => a.has(m) && !common.has(m)).sort();
      if (shared.length) links.push({ from: ids[i], to: ids[j], kind: "data", weight: shared.length, why: shared });
    }
  }

  const all: GraphFeature[] = [...feFeatures.values()].map((f) => {
    const used = [...usesModels.get(f.id)!];
    return {
      id: f.id,
      label: labelOf(f.id),
      group: f.id.startsWith("editor/") ? "Editors" : "Dashboard",
      module: f.module,
      files: f.files,
      pages: [...f.pages].sort(),
      models: used
        .filter((m) => !common.has(m))
        .sort()
        .map((name) => ({ name, area: models.get(name) ?? "" })),
      common: used.filter((m) => common.has(m)).sort(),
      helper: f.pages.size === 0 && f.files <= 2,
    };
  });
  const linked = new Set(links.flatMap((l) => [l.from, l.to]));
  const isUnused = (f: GraphFeature) => !f.pages.length && !f.models.length && !linked.has(f.id);
  const features = all.filter((f) => !isUnused(f));
  const unused = all.filter(isUnused).map((f) => f.module);
  return { ready: true, missing, features, links, unused, builtAt: new Date().toISOString(), ms: Date.now() - started };
}
