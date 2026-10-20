// QA run panel parsers and gates against fixture rounds.
// Run: npx tsx server/test/qa.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "fixtures", "qa-runs");
// Before importing qa.ts: config.ts writes its config into CRUX_HOME.
process.env.CRUX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crux-qa-test-"));
process.env.CRUX_QA_SKILLS = path.join(here, "fixtures", "skills");
const qa = await import("../src/qa.js");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n${(err as Error).stack}`);
    process.exitCode = 1;
  }
}

await test("lists targets and rounds, newest first; ignores .locks", () => {
  const all = qa.listRounds(ROOT);
  assert.deepEqual(all, [
    { target: "mr-5265", rounds: [2, 1] },
    { target: "mr-5300", rounds: [1] },
  ]);
  assert.deepEqual(qa.listRounds(ROOT, { mr: "5300" }).map((t) => t.target), ["mr-5300"]);
  assert.deepEqual(qa.listRounds(ROOT, { mr: "530" }), []);
});

await test("rejects path traversal in target and n", () => {
  for (const t of ["..", ".locks", "../etc", "a/b", "", "a\\b"]) assert.equal(qa.validTarget(t), false, t);
  for (const n of ["0", "-1", "1/..", "01", "12345", "x"]) assert.equal(qa.validN(n), false, n);
  assert.throws(() => qa.roundDir(ROOT, "..", 1));
});

await test("skills: version and check script found", () => {
  const s = qa.skillsInfo();
  assert.equal(s.version, "2.0.0");
  assert.equal(s.check, true);
  assert.equal(s.lite, true);
});

await test("round mid-Batch 1: tier, stale facts, write classes, status", () => {
  const r = qa.readRound(ROOT, "mr-5265", 1);
  assert.equal(r.exists, true);
  assert.equal(r.tier, "Standard");
  assert.deepEqual(r.stale, ['Lab org "Demo 3" was renamed', "Token expiry is now 40 minutes"]);
  assert.deepEqual(
    r.writeClasses.map((w) => [w.name, w.granted, w.limits]),
    [["Create tour", false, ""], ["Edit org settings", true, "only demo-org"], ["Delete media", false, ""]],
  );
  assert.deepEqual(r.batches.map((b) => b.status), ["running", "pending", "pending", "pending", "pending"]);
  assert.equal(r.current, 1);
  assert.equal(r.pause, null);
  assert.deepEqual(r.lanes, []);
  assert.equal(r.timings, null);
  assert.equal(r.report, null);
  assert.equal(r.locks.length, 2);
  assert.match(r.batches[0].block, /Started: 2026-10-20/);
});

await test("failing check_round.py surfaces as gate fail with open lines", async () => {
  const g = await qa.checkRound(ROOT, "mr-5265", 1, { batch: 1 });
  assert.equal(g.ran, true);
  assert.equal(g.ok, false);
  assert.equal(g.code, 1);
  assert.deepEqual(g.lines.filter((l) => l.open).length, 2);
  assert.equal(g.lines[0].open, false);
  // Cached: the round now carries the gate on its batch and as the current gate.
  const r = qa.readRound(ROOT, "mr-5265", 1);
  assert.equal(r.batches[0].gate?.ok, false);
  assert.equal(r.gate?.code, 1);
});

await test("passing check is a gate pass", async () => {
  const g = await qa.checkRound(ROOT, "mr-5265", 2, { batch: 1 });
  assert.equal(g.ok, true);
  assert.equal(g.code, 0);
  assert.equal(g.lines.some((l) => l.open), false);
});

await test("paused round after Batch 2: cases by area, findings, timings, worktrees", () => {
  const r = qa.readRound(ROOT, "mr-5265", 2);
  assert.equal(r.tier, "Deep");
  assert.deepEqual(r.batches.slice(0, 3).map((b) => b.status), ["done", "paused", "pending"]);
  assert.equal(r.current, 2);
  assert.ok(r.pause);
  assert.equal(r.pause!.after, 2);
  assert.deepEqual(
    r.pause!.cases.map((a) => [a.area, a.cases.map((c) => c.id)]),
    [["Tours", ["C-01", "C-02", "C-03"]], ["Billing", ["C-04", "C-05"]]],
  );
  assert.equal(r.pause!.cases[0].cases[0].title, "Create a tour from the dashboard");
  assert.deepEqual(
    r.findings.map((f) => [f.id, f.severity, f.status]),
    [["F-01", "High", "fixed"], ["F-02", "Medium", "verified"], ["F-03", "Low", "open"]],
  );
  assert.deepEqual(r.timings, { wall: 5400, active: 3600, pause: 1800 });
  assert.deepEqual(r.worktrees, ["lane-api", "lane-ui"]);
});

await test("Batch 3 round: lanes in each status, report, nested timings", () => {
  const r = qa.readRound(ROOT, "mr-5300", 1);
  assert.equal(r.pause, null);
  assert.equal(r.current, 3);
  const lanes = Object.fromEntries(r.lanes.map((l) => [l.name, l]));
  assert.deepEqual(Object.keys(lanes), ["api", "code", "design", "media", "perf", "ui"]);
  assert.deepEqual(
    { ...lanes.api, fields: undefined },
    { name: "api", status: "done", cases: 14, pass: 11, fail: 2, blocked: 1, not_tested: 0, reason: undefined, fields: undefined },
  );
  assert.equal(lanes.ui.status, "running");
  assert.equal(lanes.perf.status, "partial");
  assert.equal(lanes.perf.reason, "lab rate limit");
  assert.equal(lanes.media.status, "skipped");
  assert.equal(lanes.media.reason, "no J, K or L change");
  assert.equal(lanes.design.status, "blocked");
  assert.equal(lanes.code.status, "not started");
  assert.deepEqual(r.report, { findings: 2, url: "https://claude.ai/artifact/x" });
  assert.deepEqual(r.timings, { wall: 4000, active: 3000, pause: 1000 });
});

await test("batch and lane gates fail from check_round.py exit codes", async () => {
  const b = await qa.checkRound(ROOT, "mr-5300", 1, { batch: 3 });
  assert.equal(b.ok, false);
  assert.equal(b.code, 2);
  assert.deepEqual(b.lines.filter((l) => l.open).map((l) => l.text), ["✗ lane ui: status=running", "✗ lane design: 3 blocked cases without a reason"]);
  const l = await qa.checkRound(ROOT, "mr-5300", 1, { lane: "design" });
  assert.equal(l.ok, false);
  assert.equal(l.lines[0].open, true);
  await assert.rejects(qa.runCheck(path.join(ROOT, "mr-5300", "round-1"), { lane: "../x" }));
});

await test("missing round reads as an empty state", () => {
  const r = qa.readRound(ROOT, "mr-9999", 3);
  assert.equal(r.exists, false);
  assert.equal(r.tier, "");
  assert.deepEqual(r.cases, []);
  assert.equal(r.batches.length, 5);
  assert.deepEqual(qa.listRounds(path.join(ROOT, "nope")), []);
});

await test("re-run task text comes from findings.md", () => {
  const prev = { dir: path.join(ROOT, "mr-5265", "round-2"), n: 2 };
  assert.equal(qa.taskFor({ skill: "qa-full-pass", mr: "5265", mode: "full" }), "/qa-full-pass !5265");
  assert.equal(qa.taskFor({ skill: "qa-lite", mr: "5265", mode: "plan-only" }), "/qa-lite !5265 plan-only");
  assert.equal(
    qa.taskFor({ skill: "qa-full-pass", mr: "5265", mode: "retest", prev }),
    `/qa-full-pass !5265 retest (previous round: ${prev.dir}; re-test findings: F-01, F-03)`,
  );
  assert.equal(
    qa.taskFor({ skill: "qa-full-pass", mr: "5265", mode: "full", prev }),
    `/qa-full-pass !5265 as round 3 (previous round: ${prev.dir}; findings: F-01, F-02, F-03)`,
  );
});

await test("never writes into the round folder", () => {
  const before = fs.readdirSync(path.join(ROOT, "mr-5300", "round-1")).sort();
  qa.readRound(ROOT, "mr-5300", 1);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "mr-5300", "round-1")).sort(), before);
});

fs.rmSync(process.env.CRUX_HOME!, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
