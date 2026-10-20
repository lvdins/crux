import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Exercise Setup without accessing real credentials or changing user config.
const dir = mkdtempSync(path.join(tmpdir(), "crux-health-"));
const oldConfig = process.env.CRUX_CONFIG;
process.env.CRUX_CONFIG = path.join(dir, "config.json");
writeFileSync(process.env.CRUX_CONFIG, JSON.stringify({ repos: {} }));
const originalExec = childProcess.execFile;
let remote = "";
let authenticated = false;
childProcess.execFile = ((cmd: string, args: string[], _options: unknown, callback: Function) => {
  let out = "";
  let code = 0;
  if (cmd === "git") out = remote;
  else if (cmd === "/usr/bin/which" || cmd === "where") out = `/tools/${args[0]}`;
  else if (args[0] === "--version") out = "1.0";
  else if (cmd === "glab") code = authenticated ? 0 : 1;
  else if (cmd === "claude") out = '{"loggedIn":true}';
  else if (cmd === "codex") out = "Logged in";
  callback(code ? Object.assign(new Error("Authentication failed"), { code }) : null, out, "");
}) as typeof childProcess.execFile;
syncBuiltinESMExports();

try {
  const { config } = await import("../src/config.js");
  const { checkSetup } = await import("../src/health.js");
  config.repos = { test: { path: "/test", label: "Test", kind: "playwright" } };
  for (remote of [
    "git@bitbucket.org:team/repo.git",
    "https://bitbucket.org/team/repo.git",
    "ssh://git@altssh.bitbucket.org:443/team/repo.git",
    "git@github.com:team/repo.git",
  ]) {
    const result = (await checkSetup()).find((tool) => tool.name === "glab")!;
    assert.equal(result.required, false, `${remote} must not require GitLab authentication`);
    assert.equal(result.fix, null, `${remote} must not suggest a GitLab login`);
  }
  for (remote of ["git@gitlab.com:team/repo.git", "git@code.example.com:team/repo.git"]) {
    authenticated = false;
    const failed = (await checkSetup()).find((tool) => tool.name === "glab")!;
    assert.equal(failed.required, true);
    assert.equal(failed.login?.ok, false);
    authenticated = true;
    const passed = (await checkSetup()).find((tool) => tool.name === "glab")!;
    assert.equal(passed.login?.ok, true);
    assert.equal(passed.fix, null);
  }
  console.log("health: Bitbucket/GitHub exclusion and GitLab login checks passed");
} finally {
  childProcess.execFile = originalExec;
  syncBuiltinESMExports();
  if (oldConfig === undefined) delete process.env.CRUX_CONFIG;
  else process.env.CRUX_CONFIG = oldConfig;
  rmSync(dir, { recursive: true, force: true });
}
