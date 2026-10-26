// Run: npx tsx server/src/__tests__/ports.test.ts
import assert from "node:assert/strict";
import { isLocalUrl, matchPorts, parseLsof, parseNetstat, parsePs, parseSs, parseWinProcs } from "../ports.js";

/* ---------- lsof -F pn: p line, then f/n pairs per fd ---------- */
assert.deepEqual(
  parseLsof("p1262\nf40\nn127.0.0.1:9277\nf41\nn[::1]:9277\np88\nf12\nn*:5173\n"),
  [
    { pid: 1262, port: 9277 },
    { pid: 1262, port: 9277 },
    { pid: 88, port: 5173 },
  ],
);
assert.deepEqual(parseLsof(""), []);

/* ---------- ss -ltnpH: several pids on one line ---------- */
assert.deepEqual(
  parseSs(
    'LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=4321,fd=20))\n' +
      'LISTEN 0      4096            [::]:3000         [::]:*    users:(("node",pid=10,fd=3),("node",pid=11,fd=3))\n' +
      "LISTEN 0      128          0.0.0.0:22        0.0.0.0:*\n",
  ),
  [
    { pid: 4321, port: 5173 },
    { pid: 10, port: 3000 },
    { pid: 11, port: 3000 },
  ],
);

/* ---------- netstat -ano: listener = foreign 0.0.0.0:0 / [::]:0, state localized ---------- */
assert.deepEqual(
  parseNetstat(
    "\r\nAktive Verbindungen\r\n\r\n  Proto  Lokale Adresse  Remoteadresse  Status  PID\r\n" +
      "  TCP    0.0.0.0:5173   0.0.0.0:0   ABHÖREN   1234\r\n" +
      "  TCP    127.0.0.1:5173   127.0.0.1:50000   HERGESTELLT   1234\r\n" +
      "  TCP    [::1]:8080   [::]:0   ABHÖREN   99\r\n",
  ),
  [
    { pid: 1234, port: 5173 },
    { pid: 99, port: 8080 },
  ],
);

/* ---------- ps: basename of full-path comm, names with spaces ---------- */
assert.deepEqual(
  parsePs("    1     0 /sbin/launchd\n  500     1 /opt/homebrew/Cellar/node@24/24.1.0/bin/node\n  501   500 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n  502   501 vite\n"),
  [
    { pid: 1, ppid: 0, command: "launchd" },
    { pid: 500, ppid: 1, command: "node" },
    { pid: 501, ppid: 500, command: "Google Chrome" },
    { pid: 502, ppid: 501, command: "vite" },
  ],
);

/* ---------- Windows process list: pid,ppid,created,name ---------- */
assert.deepEqual(parseWinProcs("4,0,0,System\r\n800,4,133000000000000000,node.exe\r\n"), [
  { pid: 4, ppid: 0, created: 0, command: "System" },
  { pid: 800, ppid: 4, created: 133000000000000000, command: "node.exe" },
]);

/* ---------- localhost-only URL guard ---------- */
assert.equal(isLocalUrl("http://localhost:5173/"), true);
assert.equal(isLocalUrl("http://127.0.0.1:3000/"), true);
assert.equal(isLocalUrl("http://[::1]:8080/"), true);
assert.equal(isLocalUrl("http://localhost.evil.com:80/"), false);
assert.equal(isLocalUrl("https://example.com/"), false);
assert.equal(isLocalUrl("file:///etc/passwd"), false);
assert.equal(isLocalUrl("http://localhost:5173/?a=1&calc"), false);

/* ---------- matching listeners to Crux terminals ---------- */
const roots = new Map([[100, { termId: "t1", ws: "crux" }]]);
const procs = [
  { pid: 100, ppid: 1, command: "zsh" },
  { pid: 200, ppid: 100, command: "node" }, // child of the shell
  { pid: 300, ppid: 200, command: "vite" }, // grandchild
  { pid: 400, ppid: 1, command: "postgres" }, // not ours
];
assert.deepEqual(
  matchPorts(
    [
      { pid: 300, port: 5173 },
      { pid: 300, port: 5173 }, // IPv6 duplicate
      { pid: 200, port: 3000 },
      { pid: 400, port: 5432 },
      { pid: 100, port: 8000 }, // the shell itself (exec python -m http.server)
    ],
    procs,
    roots,
  ),
  [
    { port: 3000, pid: 200, command: "node", termId: "t1", ws: "crux", isShell: false },
    { port: 5173, pid: 300, command: "vite", termId: "t1", ws: "crux", isShell: false },
    { port: 8000, pid: 100, command: "zsh", termId: "t1", ws: "crux", isShell: true },
  ],
);
// ppid cycle terminates
assert.deepEqual(matchPorts([{ pid: 7, port: 1 }], [{ pid: 7, ppid: 8, command: "a" }, { pid: 8, ppid: 7, command: "b" }], roots), []);
// Windows: parent pid reused by a newer process doesn't count
assert.deepEqual(
  matchPorts(
    [{ pid: 900, port: 4000 }],
    [
      { pid: 100, ppid: 1, command: "pwsh.exe", created: 50 }, // started after its "child": pid reuse
      { pid: 900, ppid: 100, command: "node.exe", created: 10 },
    ],
    roots,
  ),
  [],
);

console.log("ports parsers ok");
