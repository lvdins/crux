import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface TestCase {
  title: string;
  line: number;
}

export interface TestFile {
  path: string; // relative to repo root
  describe?: string;
  tests: TestCase[];
  endpoints: string[]; // API paths referenced in the file — the cross-links
}

export interface RepoTree {
  key: string;
  label: string;
  kind: string;
  files: TestFile[];
  error?: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", "__pycache__", ".venv", "venv", "blob-report", "playwright-report", "test-results", ".pytest_cache", "dist", "build"]);

export { SKIP_DIRS, walk };

function* walk(dir: string, root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        yield* walk(path.join(dir, entry.name), root);
      }
    } else {
      yield path.join(dir, entry.name);
    }
  }
}

const ENDPOINT_RE = /["'`](\/(?:api|v\d|internal|public)[a-zA-Z0-9_\-\/{}.:$]*)["'`]/g;

function extractEndpoints(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(ENDPOINT_RE)) {
    found.add(match[1]);
    if (found.size >= 8) break;
  }
  return [...found];
}

function parsePlaywrightFile(abs: string, rel: string): TestFile | null {
  const source = fs.readFileSync(abs, "utf8");
  const lines = source.split("\n");
  const tests: TestCase[] = [];
  let describe: string | undefined;
  lines.forEach((line, i) => {
    const d = line.match(/test\.describe(?:\.(?:serial|parallel|only))?\s*\(\s*["'`](.+?)["'`]/);
    if (d && !describe) describe = d[1];
    const t = line.match(/^\s*test\s*\(\s*["'`](.+?)["'`]/) || line.match(/^\s*test\.(?:only|fixme|skip)\s*\(\s*["'`](.+?)["'`]/);
    if (t) tests.push({ title: t[1], line: i + 1 });
  });
  if (tests.length === 0 && !rel.includes("setup")) return null;
  return { path: rel, describe, tests, endpoints: extractEndpoints(source) };
}

function parsePytestFile(abs: string, rel: string): TestFile | null {
  const source = fs.readFileSync(abs, "utf8");
  const lines = source.split("\n");
  const tests: TestCase[] = [];
  let describe: string | undefined;
  lines.forEach((line, i) => {
    const c = line.match(/^class\s+(Test\w+)/);
    if (c && !describe) describe = c[1];
    const t = line.match(/^\s*(?:async\s+)?def\s+(test_\w+)/);
    if (t) tests.push({ title: t[1], line: i + 1 });
  });
  if (tests.length === 0) return null;
  return { path: rel, describe, tests, endpoints: extractEndpoints(source) };
}

export function buildTree(): RepoTree[] {
  const out: RepoTree[] = [];
  for (const [key, repo] of Object.entries(config.repos)) {
    if (repo.kind === "mkdocs") continue;
    const tree: RepoTree = { key, label: repo.label, kind: repo.kind, files: [] };
    if (!fs.existsSync(repo.path)) {
      tree.error = `Path not found: ${repo.path}`;
      out.push(tree);
      continue;
    }
    for (const abs of walk(repo.path, repo.path)) {
      const rel = path.relative(repo.path, abs);
      let parsed: TestFile | null = null;
      if (repo.kind === "playwright" && (/\.spec\.ts$/.test(abs) || /\.setup\.ts$/.test(abs))) {
        parsed = parsePlaywrightFile(abs, rel);
      } else if (repo.kind === "pytest" && /(^|\/)test_[^/]*\.py$/.test(abs)) {
        parsed = parsePytestFile(abs, rel);
      }
      if (parsed) tree.files.push(parsed);
    }
    tree.files.sort((a, b) => a.path.localeCompare(b.path));
    out.push(tree);
  }
  return out;
}

/** Endpoints referenced by more than one repo — the overlap the tree exists to show. */
export function sharedEndpoints(trees: RepoTree[]): { endpoint: string; repos: Record<string, string[]> }[] {
  const byEndpoint = new Map<string, Record<string, string[]>>();
  for (const tree of trees) {
    for (const file of tree.files) {
      for (const ep of file.endpoints) {
        const entry = byEndpoint.get(ep) ?? {};
        (entry[tree.key] ??= []).push(file.path);
        byEndpoint.set(ep, entry);
      }
    }
  }
  return [...byEndpoint.entries()]
    .filter(([, repos]) => Object.keys(repos).length > 1)
    .map(([endpoint, repos]) => ({ endpoint, repos }))
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}
