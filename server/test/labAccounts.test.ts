/**
 * Lab account switcher: locks, persona file, refresh math, Keychain.
 * Run: npx tsx server/test/labAccounts.test.ts (uses temp CRUX_HOME / QA_ROOT).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crux-lab-"));
process.env.CRUX_HOME = path.join(tmp, "home");
process.env.QA_ROOT = path.join(tmp, "qa-runs");
const fx = await import("../src/fixtures.js");
const secrets = await import("../src/secrets.js");

let passed = 0;
const test = async (name: string, fn: () => unknown) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

// A fake team mint script: prints a session that expires in 40 minutes.
const mint = path.join(tmp, "mint.mjs");
fs.writeFileSync(
  mint,
  `const exp = Math.floor(Date.now() / 1000) + 40 * 60;
console.log("minting for", process.env.CRUX_FIXTURE);
console.log(JSON.stringify({
  cookies: [
    { name: "sid", value: "s-" + process.env.CRUX_FIXTURE, domain: ".lab.example.com", path: "/", expires: exp, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "other", value: "x", domain: "elsewhere.test", path: "/" },
  ],
  storageState: { cookies: [], origins: [{ origin: "https://lab.example.com", localStorage: [{ name: "t", value: "tok" }] }] },
  env: { LAB_TOKEN: "tok-" + process.env.CRUX_FIXTURE, SECRET_SEEN: process.env.LAB_PASSWORD ? "yes" : "no" },
  expiresAt: exp,
}));`,
);
const command = `${process.execPath} ${mint}`;
const round = path.join(process.env.QA_ROOT!, "mr-5265", "round-3");
fs.mkdirSync(round, { recursive: true });
const ws = path.join(tmp, "ws");
fs.mkdirSync(ws);
const locks = path.join(process.env.QA_ROOT!, ".locks");

fx.saveFixtures([
  { id: "cs-admin", label: "Native CS admin", placeholder: "<CS_ADMIN>", env: {}, hosts: ["app.lab.example.com"], mint: { command }, persona: "admin" },
  { id: "viewer", label: "Viewer", placeholder: "<VIEWER>", env: {}, hosts: [], mint: { command } },
  { id: "taken", label: "Taken", placeholder: "<TAKEN>", env: {}, hosts: [], mint: { command }, account: "ACC_TAKEN" },
]);

await test("fixtures.json has no secrets and mode 0600", () => {
  assert.equal(fs.statSync(fx.FIXTURES_FILE).mode & 0o777, 0o600);
  assert.equal(fx.loadFixtures().length, 3);
  assert.throws(() => fx.saveFixtures([{ id: "bad id", mint: { command } }]), /letters/);
});

await test("activate takes the lock, writes owner.json and the persona file (0600)", async () => {
  const a = await fx.activate("cs-admin", { ws: "w1", round: "mr-5265/round-3", cwd: ws });
  assert.ok(fs.statSync(path.join(locks, "cs-admin")).isDirectory());
  const owner = JSON.parse(fs.readFileSync(path.join(locks, "cs-admin", "owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.ws, "w1");
  assert.equal(owner.round, round);
  const persona = path.join(round, "pw", "auth", "admin.json");
  assert.equal(a.persona, persona);
  assert.equal(fs.statSync(persona).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(persona, "utf8")).origins[0].origin, "https://lab.example.com");
  // Host filter: only the lab cookie, domain-wide with Crux's extra dot.
  assert.equal(a.cookies.length, 1);
  assert.match(a.cookies[0], /^sid=s-cs-admin; Domain=\.\.lab\.example\.com; Path=\/; Expires=.*; Secure; HttpOnly; SameSite=Lax$/);
  const st = fx.listFixtures().fixtures.find((f) => f.id === "cs-admin")!.lock;
  assert.equal(st.state, "held");
  assert.ok(st.state === "held" && st.mine);
});

await test("agents of that workspace get the env and the placeholder only", () => {
  const env = fx.accountEnv("w1");
  assert.equal(env.CRUX_ACCOUNT, "<CS_ADMIN>");
  assert.equal(env.LAB_TOKEN, "tok-cs-admin");
  assert.equal(env.CRUX_PERSONA_FILE, path.join(round, "pw", "auth", "admin.json"));
  assert.equal(fs.statSync(env.CRUX_ACCOUNT_ENV).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(env.CRUX_ACCOUNT_ENV, "utf8"), /export CRUX_ACCOUNT='<CS_ADMIN>'/);
  assert.deepEqual(fx.accountEnv("w2"), {});
});

await test("a second activate of the same fixture reports it held", async () => {
  await assert.rejects(fx.activate("cs-admin", { ws: "w2", cwd: ws }), /active in workspace w1/);
});

await test("a lock held by another run is reported with its holder and never removed", async () => {
  fs.mkdirSync(path.join(locks, "ACC_TAKEN"), { recursive: true });
  fs.writeFileSync(path.join(locks, "ACC_TAKEN", "owner.json"), JSON.stringify({ pid: 999999, ws: "other", round: "r9", at: "x" }));
  await assert.rejects(fx.activate("taken", { ws: "w2", cwd: ws }), (err: Error & { status?: number }) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /locked by Crux pid 999999 \(workspace other, round r9\), not running/);
    return true;
  });
  assert.equal(fx.release("taken"), false);
  assert.ok(fs.existsSync(path.join(locks, "ACC_TAKEN", "owner.json")));
  // A skill lock without owner.json.
  fs.mkdirSync(path.join(locks, "viewer"));
  await assert.rejects(fx.activate("viewer", { ws: "w2", cwd: ws }), /another run \(no owner.json\)/);
  fs.rmdirSync(path.join(locks, "viewer"));
});

await test("switching fixture releases the old lock only after the new one works", async () => {
  await fx.activate("viewer", { ws: "w1", cwd: ws });
  assert.ok(!fs.existsSync(path.join(locks, "cs-admin")));
  assert.ok(fs.existsSync(path.join(locks, "viewer")));
  assert.equal(fx.accountEnv("w1").CRUX_ACCOUNT, "<VIEWER>");
});

await test("release removes only our lock", async () => {
  // Someone replaced our lock's owner: we must not remove it.
  await fx.activate("cs-admin", { ws: "w3", cwd: ws });
  fs.writeFileSync(path.join(locks, "cs-admin", "owner.json"), JSON.stringify({ pid: 1, ws: "x", round: null, at: "y" }));
  fx.release("cs-admin");
  assert.ok(fs.existsSync(path.join(locks, "cs-admin")));
  fs.rmSync(path.join(locks, "cs-admin"), { recursive: true });
  assert.equal(fx.release("viewer"), true);
  assert.ok(!fs.existsSync(path.join(locks, "viewer")));
  assert.ok(fs.existsSync(path.join(locks, "ACC_TAKEN")));
  assert.deepEqual(fx.accountEnv("w1"), {});
});

await test("a failing mint keeps the old fixture and frees the new lock", async () => {
  await fx.activate("viewer", { ws: "w1", cwd: ws });
  const list = fx.loadFixtures();
  fx.saveFixtures([...list, { id: "broken", label: "Broken", placeholder: "<B>", env: {}, hosts: [], mint: { command: `${process.execPath} -e process.exit(3)` } }]);
  await assert.rejects(fx.activate("broken", { ws: "w1", cwd: ws }), /Mint for Broken failed/);
  assert.ok(!fs.existsSync(path.join(locks, "broken")));
  assert.equal(fx.accountEnv("w1").CRUX_ACCOUNT, "<VIEWER>");
  fx.release("viewer");
});

await test("rounds must be inside QA_ROOT", async () => {
  await assert.rejects(fx.activate("viewer", { ws: "w1", round: "../../etc", cwd: ws }), /inside/);
  assert.ok(!fs.existsSync(path.join(locks, "viewer")));
});

await test("refresh is scheduled 5 minutes before expiry", () => {
  const now = 1_000_000_000_000;
  assert.equal(fx.refreshDelay(null, now), null);
  assert.equal(fx.refreshDelay(now + 40 * 60_000, now), 35 * 60_000);
  assert.equal(fx.refreshDelay(now + 6 * 60_000, now), 60_000);
  assert.equal(fx.refreshDelay(now + 60_000, now), 15_000); // already inside the window: soon, not in a loop
  assert.equal(fx.refreshDelay(now + 90 * 86_400_000, now), 2 ** 31 - 1);
  assert.equal(fx.normaliseExpiry(1_700_000_000), 1_700_000_000_000);
  assert.equal(fx.normaliseExpiry("2026-10-20T10:00:00Z"), Date.parse("2026-10-20T10:00:00Z"));
});

await test("mint output: log lines before the JSON, cookie lines kept", () => {
  const m = fx.parseMint('hello\n{"cookies":["a=1; Domain=x.test; Path=/"],"env":{"A":"1","bad-key":"x"},"expiresAt":"2026-10-20T10:00:00Z"}');
  assert.deepEqual(m.cookies, ["a=1; Domain=x.test; Path=/"]);
  assert.deepEqual(m.env, { A: "1" });
  assert.throws(() => fx.parseMint("nope"), /didn't print JSON/);
});

if (process.platform === "darwin") {
  await test("Keychain: set, read, list, delete (throwaway name)", async () => {
    const name = `crux-test-${process.pid}`;
    try {
      await secrets.setSecret(name, "pa ss'word");
      assert.equal(await secrets.getSecret(name), "pa ss'word");
      assert.deepEqual((await secrets.listSecrets()).find((s) => s.name === name), { name, set: true });
      // Secrets reach the mint script as env; fixtures.json only holds the name.
      fx.saveFixtures([{ id: "kc", label: "KC", placeholder: "<KC>", env: { LAB_PASSWORD: name }, hosts: [], mint: { command } }]);
      assert.ok(!fs.readFileSync(fx.FIXTURES_FILE, "utf8").includes("pa ss"));
      await fx.activate("kc", { ws: "w1", cwd: ws });
      assert.equal(fx.accountEnv("w1").SECRET_SEEN, "yes");
      fx.release("kc");
    } finally {
      await secrets.deleteSecret(name);
    }
    assert.equal(await secrets.getSecret(name), null);
    assert.equal(await secrets.hasSecret(name), false);
  });
} else {
  await test("secrets: not supported off macOS", async () => {
    await assert.rejects(secrets.setSecret("x", "y"), /not supported/);
  });
}

fx.releaseAll();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed`);
