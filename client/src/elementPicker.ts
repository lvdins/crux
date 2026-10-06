/**
 * Element picker for the in-app browser. Runs in WebKit's isolated client
 * world (shares the DOM, not the page's JS): hover highlights, click picks,
 * Escape cancels. Returns a description plus Playwright locator suggestions,
 * each checked for how many elements it matches.
 */

export interface PickedLocator {
  kind: string;
  code: string;
  matches: number;
}

export interface PickedElement {
  tag: string;
  id: string;
  classes: string[];
  text: string;
  role: string;
  name: string;
  size: string;
  attributes: Record<string, string>;
  locators: PickedLocator[];
}

export const CANCEL_PICK_SCRIPT = `if (window.__qlPickCancel) window.__qlPickCancel(); return "ok";`;

export const PICK_SCRIPT = String.raw`
if (window.__qlPickCancel) window.__qlPickCancel();
const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
const q = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const roleOf = (el) => {
  const r = el.getAttribute("role");
  if (r) return r;
  const t = el.tagName.toLowerCase();
  if (t === "a" && el.hasAttribute("href")) return "link";
  if (t === "button" || t === "summary") return "button";
  if (t === "select") return "combobox";
  if (t === "textarea") return "textbox";
  if (/^h[1-6]$/.test(t)) return "heading";
  if (t === "img") return "img";
  if (t === "input") {
    const ty = (el.type || "text").toLowerCase();
    if (ty === "checkbox" || ty === "radio") return ty;
    if (["submit", "button", "reset"].includes(ty)) return "button";
    return "textbox";
  }
  return "";
};
const labelText = (el) => (el.labels && el.labels[0] ? clean(el.labels[0].innerText) : "");
const nameOf = (el) =>
  clean(el.getAttribute("aria-label") || labelText(el) || el.getAttribute("alt") || el.getAttribute("title") || (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ? "" : el.innerText)).slice(0, 80);
const short = (el) => {
  let s = el.tagName.toLowerCase();
  if (el.id) s += "#" + el.id;
  const cls = [...el.classList].filter((c) => !/^(css|sc|jsx|emotion)-|[0-9a-f]{6,}/i.test(c)).slice(0, 2);
  if (cls.length) s += "." + cls.join(".");
  return s;
};
const cssPath = (el) => {
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  if (el.id && document.querySelectorAll("#" + esc(el.id)).length === 1) return "#" + esc(el.id);
  const tid = el.getAttribute("data-testid");
  if (tid && document.querySelectorAll('[data-testid="' + tid + '"]').length === 1) return '[data-testid="' + tid + '"]';
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    let part = node.tagName.toLowerCase();
    if (node.id) { parts.unshift("#" + esc(node.id)); break; }
    const sibs = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
    if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
    parts.unshift(part);
    const sel = parts.join(" > ");
    if (document.querySelectorAll(sel).length === 1) return sel;
    node = node.parentElement;
  }
  return parts.join(" > ");
};
const countRole = (role, name) => [...document.querySelectorAll("*")].filter((e) => roleOf(e) === role && nameOf(e) === name).length;
const countText = (text) => [...document.querySelectorAll("body *")].filter((e) => clean(e.innerText) === text && ![...e.children].some((c) => clean(c.innerText) === text)).length;

const describe = (el) => {
  const r = el.getBoundingClientRect();
  const role = roleOf(el);
  const name = nameOf(el);
  const attrs = {};
  for (const a of ["data-testid", "data-test", "name", "type", "placeholder", "href", "aria-label", "role", "for", "value"]) {
    const v = el.getAttribute(a);
    if (v) attrs[a] = v.slice(0, 120);
  }
  const loc = [];
  const tid = el.getAttribute("data-testid");
  if (tid) loc.push({ kind: "test id", code: "page.getByTestId(" + q(tid) + ")", matches: document.querySelectorAll('[data-testid="' + tid + '"]').length });
  if (role && name) loc.push({ kind: "role", code: "page.getByRole(" + q(role) + ", { name: " + q(name) + " })", matches: countRole(role, name) });
  const lbl = labelText(el);
  if (lbl) loc.push({ kind: "label", code: "page.getByLabel(" + q(lbl) + ")", matches: [...document.querySelectorAll("input,textarea,select")].filter((e) => labelText(e) === lbl).length });
  if (el.getAttribute("placeholder")) loc.push({ kind: "placeholder", code: "page.getByPlaceholder(" + q(el.getAttribute("placeholder")) + ")", matches: document.querySelectorAll('[placeholder="' + el.getAttribute("placeholder").replace(/"/g, '\\"') + '"]').length });
  const text = clean(el.innerText);
  if (text && text.length <= 50 && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) loc.push({ kind: "text", code: "page.getByText(" + q(text) + ", { exact: true })", matches: countText(text) });
  const css = cssPath(el);
  loc.push({ kind: "css", code: "page.locator(" + q(css) + ")", matches: document.querySelectorAll(css).length });
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    classes: [...el.classList].slice(0, 6),
    text: text.slice(0, 160),
    role,
    name,
    size: Math.round(r.width) + "×" + Math.round(r.height),
    attributes: attrs,
    locators: loc,
  };
};

return await new Promise((resolve) => {
  const box = document.createElement("div");
  const tip = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #3ecf8e;background:rgba(62,207,142,.12);border-radius:3px;transition:all 50ms;display:none";
  tip.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#1b1c20;color:#ececee;font:11px ui-monospace,Menlo,monospace;padding:3px 7px;border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,.4);white-space:nowrap;display:none";
  document.documentElement.append(box, tip);
  const prevCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";
  let current = null;
  const show = (el) => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    tip.textContent = short(el) + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    tip.style.display = "block";
    const ty = r.top > 26 ? r.top - 24 : r.bottom + 4;
    tip.style.left = Math.max(4, Math.min(r.left, innerWidth - tip.offsetWidth - 4)) + "px";
    tip.style.top = ty + "px";
  };
  const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tip) return;
    current = el;
    show(el);
  };
  const pick = (e) => { block(e); done(current ? describe(current) : null); };
  const key = (e) => { if (e.key === "Escape") { block(e); done(null); } };
  const opts = { capture: true };
  const done = (value) => {
    removeEventListener("mousemove", move, opts);
    removeEventListener("pointerdown", block, opts);
    removeEventListener("mousedown", block, opts);
    removeEventListener("pointerup", block, opts);
    removeEventListener("mouseup", block, opts);
    removeEventListener("click", pick, opts);
    removeEventListener("keydown", key, opts);
    box.remove();
    tip.remove();
    document.documentElement.style.cursor = prevCursor;
    delete window.__qlPickCancel;
    resolve(JSON.stringify(value));
  };
  window.__qlPickCancel = () => done(null);
  addEventListener("mousemove", move, opts);
  addEventListener("pointerdown", block, opts);
  addEventListener("mousedown", block, opts);
  addEventListener("pointerup", block, opts);
  addEventListener("mouseup", block, opts);
  addEventListener("click", pick, opts);
  addEventListener("keydown", key, opts);
});
`;
