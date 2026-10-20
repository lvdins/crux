// Write guard policy from a fixture intake.md: `npx tsx server/src/guard.test.ts`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// config.ts reads (and seeds) CRUX_HOME on import: keep it away from the real one.
process.env.CRUX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crux-guard-"));
process.env.QA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "crux-qa-"));
const { buildPolicy, decide, parseWriteClasses, recordLog, readLog, writesMade, policyFor } = await import("./guard.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const md = fs.readFileSync(path.join(here, "fixtures", "guard-intake.md"), "utf8");
const LAB = "https://web.lab.example.com";

assert.equal(parseWriteClasses(md).length, 9);
const p = buildPolicy(md, "web/round-2", ["lab", "vercel.app", "preview"]);
assert.equal(p.prefix, "qa-web-r2-");

// Only "entities this run creates" granted.
const prefixed = decide(p, "POST", `${LAB}/gapi/projects`, JSON.stringify({ name: "qa-web-r2-floorplan" }));
assert.equal(prefixed.act, "allow");
assert.equal(prefixed.cls, "Entities this run creates");
assert.match(prefixed.grant ?? "", /user, 20 Oct/);
assert.equal(decide(p, "PATCH", `${LAB}/gapi/projects/qa-web-r2-floorplan`).act, "allow", "prefix in the path");

const fixture = decide(p, "POST", `${LAB}/gapi/organizations/42/members`, JSON.stringify({ email: "x@example.com" }));
assert.equal(fixture.act, "block");
assert.equal(fixture.cls, "Shared fixtures");
assert.equal(decide(p, "PUT", `${LAB}/gapi/projects/1234`, "{}").act, "block", "unclassified write blocks");
// A refusal wins over the prefix grant.
assert.equal(decide(p, "PUT", `${LAB}/gapi/organizations/42/qa-web-r2-x`).act, "block");
assert.equal(decide(p, "POST", `${LAB}/gapi/admin/flags`, "qa-web-r2-x").act, "block", "admin API");

// Production always blocks, even marked "yes" and off the guarded hosts.
assert.equal(p.rules.find((r) => r.key === "production")?.mode, "block");
assert.equal(decide(p, "POST", "https://app.example.com/gapi/projects", "qa-web-r2-x").act, "block");

assert.equal(decide(p, "POST", "https://api.sandbox.example.com/v1/charge").act, "pass", "not a guarded host");
assert.equal(decide({ ...p, hosts: ["sandbox"] }, "POST", "https://api.sandbox.example.com/v1/charge").act, "ask");
assert.equal(decide(p, "GET", `${LAB}/gapi/organizations/42`).act, "pass", "reads pass");
assert.equal(decide(p, "POST", "https://example.com/api").act, "pass", "other hosts pass");
assert.equal(decide(p, "POST", "https://feature-x.vercel.app/api/save").act, "block");

// No round: nothing granted.
assert.equal(decide(buildPolicy("", null, ["lab"]), "POST", `${LAB}/gapi/projects`, "qa-web-r2-x").act, "block");

// Log + leak check against the round's intake on disk.
fs.mkdirSync(path.join(process.env.QA_ROOT, "web", "round-2"), { recursive: true });
fs.writeFileSync(path.join(process.env.QA_ROOT, "web", "round-2", "intake.md"), md);
assert.equal(policyFor("web/round-2").prefix, "qa-web-r2-");
const row = (id: number, url: string, extra: object) => ({ page: "p1", id, method: "POST", url, start: 1, status: 200, guarded: true, ...extra });
const leaks = recordLog("ws", "web/round-2", [
  row(1, `${LAB}/gapi/projects`, { reqBody: '{"name":"qa-web-r2-a"}', class: "Entities this run creates", grant: "user" }),
  row(2, `${LAB}/gapi/organizations/42/members`, { blocked: true, class: "Shared fixtures" }),
  row(3, `${LAB}/gapi/organizations/42/members`, {}),
  row(3, `${LAB}/gapi/organizations/42/members`, {}),
]);
assert.equal(leaks.length, 1, "the unblocked fixture write is a leak (once)");
assert.equal(leaks[0].restore, "re-run the fixture seed");
const log = readLog("ws", "web/round-2");
assert.equal(log.length, 3);
assert.equal((fs.statSync(path.join(process.env.CRUX_HOME, "guard", "ws--web--round-2.json")).mode & 0o777).toString(8), "600");
assert.match(writesMade(log), /^Writes made: 1 allowed \(Entities this run creates\), 1 blocked by the write guard, 1 outside a grant/);

console.log("guard.test.ts: all passed");
