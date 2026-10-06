#!/usr/bin/env node
// Assembles build/qualitylab — everything the packaged app runs besides the
// UI: a Node runtime, the bundled server, node-pty's native bits, the agent
// browser MCP server and the default data files. The layout mirrors the
// repo so server paths work unchanged (QUALITYLAB_ROOT points here).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repo, "build", "qualitylab");
const cache = path.join(repo, "build", "cache");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const NODE_VERSION = process.env.QL_NODE_VERSION ?? process.version; // e.g. v24.15.0

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
  path.join(out, "qualitylab.config.json"),
  JSON.stringify({ repos: {}, agent: { permissionMode: "bypassPermissions" }, preview: { port: 8321 } }, null, 2) + "\n",
);
for (const f of ["qualitylab.descriptions.json", "qualitylab.features.json"]) {
  if (fs.existsSync(path.join(repo, f))) fs.copyFileSync(path.join(repo, f), path.join(out, f));
}

step("copying node-pty (darwin-" + arch + ")");
const ptySrc = path.join(repo, "node_modules", "node-pty");
const ptyOut = path.join(out, "server", "node_modules", "node-pty");
fs.mkdirSync(ptyOut, { recursive: true });
fs.copyFileSync(path.join(ptySrc, "package.json"), path.join(ptyOut, "package.json"));
fs.cpSync(path.join(ptySrc, "lib"), path.join(ptyOut, "lib"), { recursive: true, filter: (p) => !p.endsWith(".test.js") });
fs.cpSync(path.join(ptySrc, "prebuilds", `darwin-${arch}`), path.join(ptyOut, "prebuilds", `darwin-${arch}`), { recursive: true });
fs.chmodSync(path.join(ptyOut, "prebuilds", `darwin-${arch}`, "spawn-helper"), 0o755);

step(`fetching Node ${NODE_VERSION} (darwin-${arch})`);
fs.mkdirSync(cache, { recursive: true });
const tarName = `node-${NODE_VERSION}-darwin-${arch}.tar.gz`;
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
execFileSync("tar", ["-xzf", tarPath, "-C", cache, `node-${NODE_VERSION}-darwin-${arch}/bin/node`]);
fs.copyFileSync(path.join(cache, `node-${NODE_VERSION}-darwin-${arch}`, "bin", "node"), path.join(out, "node"));
fs.chmodSync(path.join(out, "node"), 0o755);

step("smoke test: bundled server loads");
execFileSync(path.join(out, "node"), ["--input-type=module", "-e", "await import('node-pty'); console.log('node-pty ok')"], {
  cwd: path.join(out, "server", "dist"),
  stdio: "inherit",
});

const size = execFileSync("du", ["-sh", out], { encoding: "utf8" }).split("\t")[0];
console.log(`\x1b[32m✓\x1b[0m build/qualitylab ready (${size})`);
