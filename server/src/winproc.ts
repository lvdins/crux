import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

/**
 * Windows: the server runs without a console, so every git / gh / glab call
 * would flash a console window of its own; and npm-installed tools (claude,
 * codex) are .cmd files, which Node only runs through a shell. Imported
 * first (index.ts), so every child process the server starts gets both.
 */
if (process.platform === "win32") {
  const SHIMS = new Set(["claude", "codex", "npm", "npx"]);
  const mod = cp as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync"]) {
    const orig = mod[name];
    mod[name] = function (this: unknown, file: unknown, ...rest: unknown[]) {
      const extra = { windowsHide: true, ...(typeof file === "string" && SHIMS.has(file) ? { shell: true } : {}) };
      const at = rest.findIndex((a) => !!a && typeof a === "object" && !Array.isArray(a));
      if (at >= 0) rest[at] = { ...extra, ...(rest[at] as object) };
      else rest.splice(Array.isArray(rest[0]) ? 1 : 0, 0, extra);
      return orig.call(this, file, ...rest);
    };
  }
  syncBuiltinESMExports();
}
