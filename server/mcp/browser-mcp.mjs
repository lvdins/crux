#!/usr/bin/env node
// crux-browser — MCP server (stdio, no dependencies) that lets an
// agent drive the browser panel of the Crux workspace it runs in.
// Requests go to the Crux server, which relays them to the desktop
// window that owns the native browser.

const WORKSPACE = process.env.CRUX_WORKSPACE;
const BASE = process.env.CRUX_URL || "http://127.0.0.1:8787";

const target = {
  ref: { type: "number", description: "Element ref from the latest browser_snapshot, e.g. 12 for [12]" },
  text: { type: "string", description: "Alternative to ref: visible text / accessible name of the element" },
  selector: { type: "string", description: "Alternative to ref: CSS selector" },
};

const TOOLS = [
  {
    name: "browser_navigate",
    description:
      "Open a URL in the Crux browser panel the user is watching (already signed in to whatever they signed in to). Waits for the page to load.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "browser_snapshot",
    description:
      "Read the current page: URL, title, headings, open dialogs, every visible interactive element with a [ref] number, and the page text. Take a fresh snapshot after anything that changes the page; refs are only valid for the latest snapshot.",
    inputSchema: { type: "object", properties: { maxText: { type: "number", description: "Max characters of page text (default 5000)" } } },
  },
  {
    name: "browser_click",
    description: "Click an element (scrolls it into view and highlights it so the user can follow along).",
    inputSchema: { type: "object", properties: target },
  },
  {
    name: "browser_type",
    description: "Type into a text field (replaces its value unless clear=false). submit=true presses Enter afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        ...target,
        value: { type: "string", description: "Text to type" },
        clear: { type: "boolean", description: "Replace existing value (default true)" },
        submit: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["value"],
    },
  },
  {
    name: "browser_press_key",
    description: "Press a key on the focused element: Enter, Escape, Tab, ArrowDown, a letter, …",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browser_select_option",
    description: "Choose an option in a native <select> by value or visible text.",
    inputSchema: { type: "object", properties: { ...target, option: { type: "string" } }, required: ["option"] },
  },
  {
    name: "browser_wait_for",
    description: "Wait until text appears (or disappears with gone=true), or a CSS selector becomes visible/gone.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        selector: { type: "string" },
        gone: { type: "boolean" },
        timeout: { type: "number", description: "Milliseconds, default 10000, max 40000" },
      },
    },
  },
  {
    name: "browser_screenshot",
    description: "PNG screenshot of what the browser panel currently shows.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_evaluate",
    description:
      "Run JavaScript in the page (sees the page's own globals). An expression or a function body with `return`; the result is JSON-serialised.",
    inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] },
  },
  { name: "browser_back", description: "Go back in history.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_forward", description: "Go forward in history.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_reload", description: "Reload the page.", inputSchema: { type: "object", properties: {} } },
  {
    name: "flow_set_module",
    description:
      "Tell Crux's Flow view which product module you are working in or testing now (e.g. \"Billing\"), and optionally the modules you'll test next. Call it when you move on to a new module.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "Module or feature name, e.g. Billing, Presets" },
        next: { type: "array", items: { type: "string" }, description: "Modules you plan to test after this one, in order" },
      },
      required: ["module"],
    },
  },
];

async function setModule(args) {
  const term = process.env.CRUX_TERM;
  if (!term) return { isError: true, content: [{ type: "text", text: "Not running inside a Crux terminal (CRUX_TERM is unset)." }] };
  try {
    const res = await fetch(`${BASE}/api/flow/module`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term, module: args?.module, next: args?.next }),
    });
    const body = await res.json();
    if (!res.ok || !body.module) return { isError: true, content: [{ type: "text", text: body.error || "Module not set" }] };
    return { content: [{ type: "text", text: `Now in: ${body.module.label}` }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Crux server unreachable at ${BASE}: ${err.message}` }] };
  }
}

async function call(name, args) {
  if (name === "flow_set_module") return setModule(args);
  if (!WORKSPACE) {
    return { isError: true, content: [{ type: "text", text: "Not running inside a Crux terminal (CRUX_WORKSPACE is unset)." }] };
  }
  const op = name.replace(/^browser_/, "");
  let body;
  try {
    const res = await fetch(`${BASE}/api/agent-browser/${encodeURIComponent(WORKSPACE)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, args: args ?? {} }),
    });
    body = await res.json();
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Crux server unreachable at ${BASE}: ${err.message}` }] };
  }
  if (!body.ok) return { isError: true, content: [{ type: "text", text: body.error || "Browser command failed" }] };
  const content = [{ type: "text", text: body.result?.text ?? "" }];
  if (body.result?.image) content.push({ type: "image", data: body.result.image, mimeType: "image/png" });
  return { content };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled, …)
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "crux-browser", version: "0.1.0" },
          instructions:
            "These tools drive the browser panel inside Crux that the user is watching. Start with browser_snapshot (or browser_navigate), act with browser_click / browser_type using [ref] numbers from the latest snapshot, and snapshot again after each change.",
        },
      });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      return send({ jsonrpc: "2.0", id, result: await call(params?.name, params?.arguments) });
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
}

let buffer = "";
let inFlight = 0;
let ended = false;
const maybeExit = () => {
  if (ended && inFlight === 0) process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      inFlight++;
      void handle(JSON.parse(line)).finally(() => {
        inFlight--;
        maybeExit();
      });
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => {
  ended = true;
  maybeExit();
});
