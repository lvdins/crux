#!/usr/bin/env node
// Assembles build/crux — everything the packaged app runs besides the
// UI: a Node runtime, the bundled server, node-pty's native bits, the agent
// browser MCP server and the default data files. The layout mirrors the
// repo so server paths work unchanged (CRUX_ROOT points here).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repo, "build", "crux");
const cache = path.join(repo, "build", "cache");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const NODE_VERSION = process.env.QL_NODE_VERSION ?? process.version; // e.g. v24.15.0
// nodejs.org names: darwin / linux / win. The packaged app runs this machine's kind.
const nodeOs = process.platform === "win32" ? "win" : process.platform;
const isWin = process.platform === "win32";
const nodeBin = isWin ? "node.exe" : "node";

const step = (msg) => console.log(`\x1b[36m›\x1b[0m ${msg}`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "server", "dist"), { recursive: true });

step("bundling server");
await build({
  entryPoints: [path.join(repo, "server", "src", "index.ts")],
  outfile: path.join(out, "server", "dist", "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["node-pty"],
  // CommonJS deps (express) call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __qlRequire } from 'node:module'; const require = __qlRequire(import.meta.url);" },
  logLevel: "warning",
});

step("copying agent browser MCP server");
fs.mkdirSync(path.join(out, "server", "mcp"), { recursive: true });
fs.copyFileSync(path.join(repo, "server", "mcp", "browser-mcp.mjs"), path.join(out, "server", "mcp", "browser-mcp.mjs"));

step("writing default data files");
// Never ship personal repo paths: teammates start with no workspaces.
fs.writeFileSync(
  path.join(out, "crux.config.json"),
  JSON.stringify({ repos: {}, agent: { permissionMode: "bypassPermissions" }, preview: { port: 8321 } }, null, 2) + "\n",
);
for (const f of ["crux.descriptions.json", "crux.features.json"]) {
  if (fs.existsSync(path.join(repo, f))) fs.copyFileSync(path.join(repo, f), path.join(out, f));
}

const target = `${process.platform}-${arch}`;
step(`copying node-pty (${target})`);
const ptySrc = path.join(repo, "node_modules", "node-pty");
const ptyOut = path.join(out, "server", "node_modules", "node-pty");
fs.mkdirSync(ptyOut, { recursive: true });
fs.copyFileSync(path.join(ptySrc, "package.json"), path.join(ptyOut, "package.json"));
fs.cpSync(path.join(ptySrc, "lib"), path.join(ptyOut, "lib"), { recursive: true, filter: (p) => !p.endsWith(".test.js") });
const prebuilt = path.join(ptySrc, "prebuilds", target);
if (fs.existsSync(prebuilt)) {
  // macOS / Windows: node-pty ships these.
  fs.cpSync(prebuilt, path.join(ptyOut, "prebuilds", target), { recursive: true });
  const helper = path.join(ptyOut, "prebuilds", target, "spawn-helper");
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
} else {
  // Linux: no prebuilds, `npm install` compiled it into build/Release.
  const built = path.join(ptySrc, "build", "Release");
  if (!fs.existsSync(built)) throw new Error(`node-pty has no ${target} build: run npm install (needs python3, make, g++)`);
  fs.mkdirSync(path.join(ptyOut, "build", "Release"), { recursive: true });
  for (const f of fs.readdirSync(built)) {
    if (f.endsWith(".node") || f === "spawn-helper") fs.copyFileSync(path.join(built, f), path.join(ptyOut, "build", "Release", f));
  }
}

step(`fetching Node ${NODE_VERSION} (${nodeOs}-${arch})`);
fs.mkdirSync(cache, { recursive: true });
const dist = `node-${NODE_VERSION}-${nodeOs}-${arch}`;
const tarName = isWin ? `${dist}.zip` : `${dist}.tar.gz`;
const tarPath = path.join(cache, tarName);
if (!fs.existsSync(tarPath)) {
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((l) => l.endsWith(`  ${tarName}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`No checksum for ${tarName}`);
  const res = await fetch(`${base}/${tarName}`);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${base}/${tarName}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${tarName}`);
  fs.writeFileSync(tarPath, buf);
}
// The zip / tarball holds node.exe at its root on Windows, bin/node elsewhere.
const inside = isWin ? `${dist}/node.exe` : `${dist}/bin/node`;
execFileSync("tar", ["-xf", tarPath, "-C", cache, inside]);
fs.copyFileSync(path.join(cache, inside), path.join(out, nodeBin));
if (!isWin) fs.chmodSync(path.join(out, nodeBin), 0o755);

step("smoke test: bundled server loads");
execFileSync(path.join(out, nodeBin), ["--input-type=module", "-e", "await import('node-pty'); console.log('node-pty ok')"], {
  cwd: path.join(out, "server", "dist"),
  stdio: "inherit",
});

const size = isWin ? "" : ` (${execFileSync("du", ["-sh", out], { encoding: "utf8" }).split("\t")[0]})`;
console.log(`\x1b[32m✓\x1b[0m build/crux ready${size}`);
