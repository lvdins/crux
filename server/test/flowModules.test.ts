// Module resolver for the Flow view. Run: npx tsx server/test/flowModules.test.ts
import assert from "node:assert/strict";
import type { GraphNode } from "../src/activity.js";
import { declareModule, forgetTerm, plannedModules, resolveModule, setModuleIndex } from "../src/flowModules.js";

setModuleIndex([
  {
    id: "billing",
    label: "Billing",
    pages: ["/billing", "/billing/invoices/:id"],
    endpoints: ["gapi/dashboard/billing/subscription", "gapi/dashboard/billing/invoices/{}"],
    tests: [{ file: "tests/billing/checkout.spec.ts", weight: 2 }, { file: "tests/api/billing/test_invoices.py", weight: 1 }],
  },
  {
    id: "presets",
    label: "Presets",
    pages: ["/manage-workspace/presets"],
    endpoints: ["gapi/dashboard/presets", "gapi/dashboard/presets/{}"],
    tests: [],
  },
  { id: "editor/floor-plan", label: "Editor · Floor plan", pages: ["/projects/:id/floor-plan"], endpoints: [], tests: [] },
  { id: "projects", label: "Projects", pages: ["/projects", "/projects/:id"], endpoints: ["gapi/dashboard/projects/{}"], tests: [{ file: "tests/dashboard/billing/test_info.py", weight: 5 }, { file: "tests/smoke/test_all.py", weight: 1 }] },
]);

const node = (meta: GraphNode["meta"] = {}): GraphNode => ({ id: "n", type: "tool", label: "", status: "running", meta });
const id = (toolName: string, toolInput: Record<string, unknown>, meta?: GraphNode["meta"]) =>
  resolveModule("t1", node(meta), { toolName, toolInput })?.id ?? null;

const cases: [string, string | null][] = [
  // file paths
  [id("Edit", { file_path: "/Users/x/dashboard/apps/dashboard/src/modules/billing/hooks/useBadge.ts" }), "billing"],
  [id("Read", { file_path: "src/modules/editor/floor-plan/Canvas.tsx" }), "editor/floor-plan"],
  [id("Write", { file_path: "/r/src/app/[locale]/[namespace]/(main)/manage-workspace/presets/page.tsx" }), "presets"],
  [id("Edit", { file_path: "/r/src/modules/auth/session.ts" }), null], // infra module: inherit
  [id("Bash", { command: "git diff src/modules/presets/api.ts | head" }), "presets"],
  [id("Edit", {}, { files: ["/r/src/modules/billing/x.ts"] }), "billing"],
  // tests
  [id("Bash", { command: "npx playwright test tests/billing/checkout.spec.ts --headed" }), "billing"],
  [id("Bash", { command: "pytest tests/api/billing/test_invoices.py::TestInvoices::test_list -x" }), "billing"],
  [id("Bash", { command: "npx playwright test tests/presets/create.spec.ts" }), "presets"], // unlinked: folder name
  [id("Read", { file_path: "/e2e/tests/projects/archive.spec.ts" }), "projects"],
  [id("Bash", { command: "pytest tests/dashboard/billing/test_info.py" }), "billing"], // folder beats a shared-endpoint link
  [id("Bash", { command: "pytest tests/smoke/test_all.py -q" }), "projects"], // linked only
  [id("Bash", { command: "npx playwright test tests/listingSpotlight/x.spec.ts" }), null],
  // URLs and endpoints
  [id("browser_navigate", { url: "https://dash.example.com/en/acme/manage-workspace/presets/" }), "presets"],
  [id("browser_navigate", { url: "http://localhost:3000/projects/42/floor-plan" }), "editor/floor-plan"],
  [id("browser_navigate", { url: "https://dash.example.com/en/acme/settings/presets/" }), "presets"], // no such page: path word
  [id("Bash", { command: "curl -s http://localhost:8000/gapi/dashboard/presets/12/?x=1" }), "presets"],
  [id("Bash", { command: "curl -X POST localhost/gapi/dashboard/billing/invoices/9/" }), "billing"],
  [id("WebFetch", { url: "https://example.com/gapi/dashboard/billing/subscription" }), "billing"],
  // nothing to go on
  [id("Bash", { command: "ls -la && npm test" }), null],
  [id("Grep", { pattern: "useBadge", path: "/r/README.md" }), null],
  [id("browser_navigate", { url: "https://google.com/" }), null],
];
cases.forEach(([got, want], i) => assert.equal(got, want, `case ${i}`));

// declareModule
assert.deepEqual(declareModule("t2", "Billing"), { id: "billing", label: "Billing" });
assert.equal(declareModule("t2", "billing")?.id, "billing");
assert.equal(declareModule("t2", "preset")?.id, "presets");
assert.equal(declareModule("t2", "Floor plan")?.id, "editor/floor-plan");
assert.deepEqual(declareModule("t2", "Checkout Flow"), { id: "checkout-flow", label: "Checkout Flow" });
assert.equal(declareModule("t2", "  "), null);

assert.equal(declareModule("t3", "Billing", ["presets", "Billing", "Reports", "presets"])?.id, "billing");
assert.deepEqual(plannedModules("t3"), [{ id: "presets", label: "Presets" }, { id: "reports", label: "Reports" }]);
// Reaching a planned module takes it off the plan.
resolveModule("t3", node(), { toolName: "browser_navigate", toolInput: { url: "/manage-workspace/presets" } });
assert.deepEqual(plannedModules("t3").map((m) => m.id), ["reports"]);
forgetTerm("t3");
assert.deepEqual(plannedModules("t3"), []);

console.log(`flowModules: ${cases.length + 10} checks passed`);
