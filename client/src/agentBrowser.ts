/**
 * Executes agent browser commands (relayed by the server from the
 * crux-browser MCP tools) against the native browser panes.
 *
 * Page helpers run in WebKit's isolated client world: they share the DOM
 * with the page but not its JavaScript, so the page can't tamper with them.
 */

export const browserLabel = (ws: string) => `browser-${ws.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
export const DEFAULT_BROWSER_URL = "https://www.google.com/";

// The agent drives whichever browser tab is active in that workspace.
export function setActiveBrowserLabel(ws: string, label: string): void {
  localStorage.setItem(`crux.browserActive.${ws}`, label);
}
export const activeBrowserLabel = (ws: string) => localStorage.getItem(`crux.browserActive.${ws}`) ?? browserLabel(ws);

/** What one command did, for Crux's own views (agents only read text/image). */
export interface Journey {
  op: string;
  url: string | null;
  title?: string;
  /** The page changed URL (or reloaded) during the command. */
  navigated: boolean;
  /** The command didn't do what was asked (no such element, timed out, …). */
  failed?: boolean;
  dialogs?: string[];
  role?: string;
  name?: string;
  ref?: number | null;
  inputType?: string | null;
}

export interface AgentResult {
  text: string;
  image?: string; // base64 PNG
  journey?: Journey;
}

// What the in-page SCRIPTS return (JSON).
interface Step {
  text: string;
  failed?: boolean;
  target?: { role: string; name: string; ref: number | null; inputType: string | null } | null;
  url?: string;
  title?: string;
  dialogs?: string[];
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

// Shared helpers, prepended to every in-page script.
const HELPERS = String.raw`
const visible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.02;
};
const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
const labelFor = (el) => {
  if (el.labels && el.labels[0]) return clean(el.labels[0].innerText);
  const by = el.getAttribute("aria-labelledby");
  if (by) return clean(by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "));
  return "";
};
const nameOf = (el) =>
  clean(
    el.getAttribute("aria-label") ||
      labelFor(el) ||
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.placeholder || el.name : "") ||
      el.innerText ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      el.value ||
      el.getAttribute("data-testid") ||
      el.querySelector("svg title")?.textContent ||
      (el.id ? "#" + el.id : "") ||
      "",
  ).slice(0, 80);
const roleOf = (el) => {
  const r = el.getAttribute("role");
  if (r) return r;
  const t = el.tagName.toLowerCase();
  if (t === "a") return "link";
  if (t === "button" || t === "summary") return "button";
  if (t === "select") return "combobox";
  if (t === "textarea") return "textbox";
  if (t === "input") {
    const ty = (el.type || "text").toLowerCase();
    if (["checkbox", "radio"].includes(ty)) return ty;
    if (["submit", "button", "reset"].includes(ty)) return "button";
    return "textbox";
  }
  if (el.isContentEditable) return "textbox";
  return "clickable";
};
const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[role=treeitem],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
const find = (a) => {
  if (a.ref != null) return document.querySelector('[data-ql-ref="' + a.ref + '"]');
  if (a.selector) return document.querySelector(a.selector);
  if (a.text) {
    const want = String(a.text).toLowerCase();
    const els = [...document.querySelectorAll(INTERACTIVE)].filter(visible);
    return els.find((e) => nameOf(e).toLowerCase() === want) || els.find((e) => nameOf(e).toLowerCase().includes(want)) || null;
  }
  return null;
};
const describe = (el) => roleOf(el) + ' "' + nameOf(el) + '"';
// Every script returns a Step as JSON (see Step in agentBrowser.ts).
const done = (text, el) => JSON.stringify({ text, target: el ? { role: roleOf(el), name: nameOf(el), ref: el.hasAttribute("data-ql-ref") ? Number(el.getAttribute("data-ql-ref")) : null, inputType: el.tagName === "INPUT" ? (el.type || "text").toLowerCase() : null } : null });
const fail = (text) => JSON.stringify({ text, failed: true });
const flash = (el) => {
  const r = el.getBoundingClientRect();
  const ring = document.createElement("div");
  ring.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #3ecf8e;border-radius:6px;box-shadow:0 0 0 4px rgba(62,207,142,.25);transition:opacity .5s;left:" + (r.left - 3) + "px;top:" + (r.top - 3) + "px;width:" + (r.width + 6) + "px;height:" + (r.height + 6) + "px";
  document.documentElement.appendChild(ring);
  setTimeout(() => (ring.style.opacity = "0"), 450);
  setTimeout(() => ring.remove(), 1000);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notFound = (a) => fail("No element matches " + JSON.stringify(a) + " — take a fresh snapshot (refs change after navigation).");
`;

const SCRIPTS: Record<string, string> = {
  snapshot: String.raw`
    document.querySelectorAll("[data-ql-ref]").forEach((e) => e.removeAttribute("data-ql-ref"));
    const vh = innerHeight;
    const els = [...document.querySelectorAll(INTERACTIVE)].filter(visible).slice(0, 300);
    const lines = els.map((el, i) => {
      const id = i + 1;
      el.setAttribute("data-ql-ref", String(id));
      let extra = "";
      if (el.tagName === "A") extra += " → " + (el.getAttribute("href") || "").slice(0, 80);
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
        const ty = (el.type || "").toLowerCase();
        if (ty === "checkbox" || ty === "radio") extra += el.checked ? " [checked]" : " [unchecked]";
        else extra += " value=" + JSON.stringify(ty === "password" ? (el.value ? "••••" : "") : String(el.value).slice(0, 60));
      }
      if (el.disabled || el.getAttribute("aria-disabled") === "true") extra += " [disabled]";
      if (el.getAttribute("aria-expanded")) extra += " [expanded=" + el.getAttribute("aria-expanded") + "]";
      if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) extra += " [selected]";
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) extra += " (off-screen)";
      return "[" + id + "] " + describe(el) + extra;
    });
    const heads = [...document.querySelectorAll("h1,h2,h3,[role=dialog] [role=heading]")].filter(visible).slice(0, 25).map((h) => h.tagName.toLowerCase() + ": " + clean(h.innerText).slice(0, 90));
    const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].filter(visible).map((d) => clean(d.getAttribute("aria-label") || d.innerText).slice(0, 120));
    const text = clean(document.body ? document.body.innerText : "").slice(0, a.maxText || 5000);
    return JSON.stringify({
      text: [
        "URL: " + location.href,
        "Title: " + document.title,
        dialogs.length ? "Open dialogs: " + dialogs.join(" | ") : "",
        heads.length ? "Headings:\n" + heads.join("\n") : "",
        "Interactive elements (" + lines.length + "):\n" + lines.join("\n"),
        "Page text:\n" + text,
      ].filter(Boolean).join("\n\n"),
      url: location.href,
      title: document.title,
      dialogs,
    });`,

  click: String.raw`
    const el = find(a);
    if (!el) return notFound(a);
    el.scrollIntoView({ block: "center", inline: "center" });
    await sleep(80);
    flash(el);
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, view: window };
    el.dispatchEvent(new PointerEvent("pointerover", o));
    el.dispatchEvent(new MouseEvent("mouseover", o));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
    return done("Clicked " + describe(el) + ".", el);`,

  type: String.raw`
    const el = a.ref != null || a.selector || a.text ? find(a) : document.activeElement;
    if (!el || el === document.body) return notFound(a);
    el.scrollIntoView({ block: "center" });
    flash(el);
    el.focus();
    const value = String(a.value ?? "");
    if (el.isContentEditable) {
      if (a.clear !== false) { document.execCommand("selectAll"); document.execCommand("delete"); }
      document.execCommand("insertText", false, value);
    } else {
      // Type key by key like a person: many inputs act on keydown/keyup
      // (search boxes, masks, autocompletes), not just on value changes.
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const keyInit = (ch) => ({ key: ch, code: /[a-z]/i.test(ch) ? "Key" + ch.toUpperCase() : /\d/.test(ch) ? "Digit" + ch : "", keyCode: ch.toUpperCase().charCodeAt(0), which: ch.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, composed: true });
      if (a.clear !== false && el.value) {
        setter.call(el, "");
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
      const chars = [...value];
      const bulk = chars.length > 120;
      if (bulk) setter.call(el, el.value + value);
      for (const ch of bulk ? [] : chars) {
        const k = keyInit(ch);
        if (!el.dispatchEvent(new KeyboardEvent("keydown", k))) continue;
        el.dispatchEvent(new KeyboardEvent("keypress", k));
        setter.call(el, el.value + ch);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
        el.dispatchEvent(new KeyboardEvent("keyup", k));
        await sleep(8);
      }
      if (bulk) {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        el.dispatchEvent(new KeyboardEvent("keyup", keyInit(chars[chars.length - 1] || " ")));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (a.submit) {
      const k = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      const go = el.dispatchEvent(new KeyboardEvent("keydown", k));
      el.dispatchEvent(new KeyboardEvent("keyup", k));
      if (go && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      await sleep(400);
    }
    return done("Typed into " + describe(el) + (a.submit ? " and pressed Enter" : "") + ".", el);`,

  press_key: String.raw`
    const el = document.activeElement || document.body;
    const key = String(a.key);
    const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, " ": 32 };
    const k = { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key, keyCode: codes[key] || key.charCodeAt(0), which: codes[key] || 0, bubbles: true, cancelable: true };
    const go = el.dispatchEvent(new KeyboardEvent("keydown", k));
    if (key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", k));
    el.dispatchEvent(new KeyboardEvent("keyup", k));
    if (go && key === "Enter" && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    if (go && key === "Tab") {
      const f = [...document.querySelectorAll(INTERACTIVE)].filter(visible);
      const i = f.indexOf(el);
      (f[i + 1] || f[0])?.focus();
    }
    await sleep(250);
    return done("Pressed " + key + " on " + (el === document.body ? "the page" : describe(el)) + ".", el === document.body ? null : el);`,

  select_option: String.raw`
    const el = find(a);
    if (!el) return notFound(a);
    if (el.tagName !== "SELECT") return fail("That element is " + describe(el) + ", not a <select>. For custom dropdowns, click it and then click the option.");
    const want = String(a.option).toLowerCase();
    const opt = [...el.options].find((o) => o.value.toLowerCase() === want || clean(o.text).toLowerCase() === want) || [...el.options].find((o) => clean(o.text).toLowerCase().includes(want));
    if (!opt) return fail("No option matching " + JSON.stringify(a.option) + ". Options: " + [...el.options].map((o) => clean(o.text)).join(", "));
    flash(el);
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return done("Selected " + JSON.stringify(clean(opt.text)) + " in " + describe(el) + ".", el);`,

  wait_for: String.raw`
    const deadline = Date.now() + Math.min(Number(a.timeout) || 10000, 40000);
    const check = () => {
      if (a.selector) { const e = document.querySelector(a.selector); const ok = !!e && visible(e); return a.gone ? !ok : ok; }
      if (a.text) { const ok = (document.body?.innerText || "").toLowerCase().includes(String(a.text).toLowerCase()); return a.gone ? !ok : ok; }
      return document.readyState === "complete";
    };
    while (Date.now() < deadline) {
      if (check()) return done("Condition met" + (a.text ? ": text " + (a.gone ? "gone" : "present") : a.selector ? ": selector " + (a.gone ? "gone" : "visible") : ": page loaded") + ". URL " + location.href);
      await sleep(200);
    }
    return fail("Timed out after " + (Number(a.timeout) || 10000) + "ms waiting for " + JSON.stringify(a));`,

  state: String.raw`return JSON.stringify({ url: location.href, title: document.title, ready: document.readyState });`,
};

async function js(label: string, body: string, args: Record<string, unknown> = {}, pageWorld = false): Promise<string> {
  const script = `const a = ${JSON.stringify(args)};\n${HELPERS}\n${body}`;
  return invoke<string>("browser_js", { label, script, pageWorld });
}

interface PageState {
  url: string;
  title: string;
  ready: string;
}

const loaded = (s: PageState) => `Loaded ${s.url}\nTitle: ${s.title}`;

async function waitForLoad(label: string, previousUrl: string | null, timeoutMs = 15000): Promise<PageState> {
  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 250));
  let last = { url: "", title: "", ready: "" };
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await js(label, SCRIPTS.state));
      if (last.ready === "complete" && (previousUrl === null || last.url !== previousUrl || Date.now() > deadline - timeoutMs + 1500)) break;
    } catch {
      /* page mid-navigation */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

async function pageState(label: string): Promise<PageState | null> {
  try {
    return JSON.parse(await js(label, SCRIPTS.state));
  } catch {
    return null;
  }
}

async function currentUrl(label: string): Promise<string | null> {
  return (await pageState(label))?.url ?? null;
}

function normaliseUrl(input: string): string {
  const t = input.trim();
  if (/^[a-z]+:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?/.test(t)) return `http://${t}`;
  return `https://${t}`;
}

export async function runAgentCommand(ws: string, op: string, args: Record<string, any>): Promise<AgentResult> {
  const label = activeBrowserLabel(ws);
  const startUrl = localStorage.getItem(`crux.browserUrl.${ws}`) ?? DEFAULT_BROWSER_URL;
  const created = await invoke<boolean>("browser_ensure", { label, url: op === "navigate" && args.url ? normaliseUrl(args.url) : startUrl });

  switch (op) {
    case "navigate": {
      const url = normaliseUrl(String(args.url ?? ""));
      const before = created ? null : await currentUrl(label);
      if (!created) await invoke("browser_navigate", { label, url });
      const s = await waitForLoad(label, before);
      return { text: loaded(s), journey: { op, url: s.url, title: s.title, navigated: true } };
    }
    case "back":
    case "forward":
    case "reload": {
      const before = op === "reload" ? null : await currentUrl(label);
      await invoke("browser_action", { label, action: op });
      const s = await waitForLoad(label, before);
      return { text: loaded(s), journey: { op, url: s.url, title: s.title, navigated: op === "reload" || s.url !== before } };
    }
    case "screenshot": {
      const image = await invoke<string>("browser_screenshot", { label });
      const s = await pageState(label);
      return { text: `Screenshot of ${s?.url ?? "the page"}`, image, journey: { op, url: s?.url ?? null, title: s?.title, navigated: false } };
    }
    case "evaluate": {
      const src = String(args.script ?? "");
      const body = /\breturn\b|;/.test(src) ? src : `return (${src});`;
      const out = await invoke<string>("browser_js", {
        label,
        script: `const __r = await (async () => { ${body} })();\nreturn JSON.stringify(__r === undefined ? null : __r, null, 2);`,
        pageWorld: true,
      });
      const s = await pageState(label);
      return { text: out, journey: { op, url: s?.url ?? null, title: s?.title, navigated: false } };
    }
    default: {
      const body = op === "state" ? undefined : SCRIPTS[op];
      if (!body) throw new Error(`Unknown browser command "${op}"`);
      const mayNavigate = op === "click" || op === "press_key" || (op === "type" && args.submit);
      const before = mayNavigate ? await currentUrl(label) : null;
      let step: Step;
      try {
        step = JSON.parse(await js(label, body, args));
      } catch (err) {
        // The page unloading mid-script (a link click) aborts the call.
        if (!mayNavigate) throw err;
        step = { text: `Done (${op}); the page started navigating.` };
      }
      let text = step.text;
      let s: PageState | null = null;
      if (mayNavigate) {
        // Navigation can start a beat after the event: watch briefly.
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
          const now = await currentUrl(label);
          if (now === null || now !== before) {
            s = await waitForLoad(label, before);
            break;
          }
        }
        text += "\n" + (s ? loaded(s) : `Still on ${before}`);
      }
      const navigated = !!s;
      s ??= step.url ? { url: step.url, title: step.title ?? "", ready: "" } : await pageState(label);
      return {
        text,
        journey: { op, url: s?.url ?? null, title: s?.title, navigated, failed: step.failed || undefined, dialogs: step.dialogs, ...step.target },
      };
    }
  }
}
