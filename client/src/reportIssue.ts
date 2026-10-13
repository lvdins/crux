/**
 * ⌘⇧C "mark an issue" in the in-app browser: the user draws a box around
 * the problem (or selects text), and the cropped screenshot of it is added
 * to the agent's input.
 */

export interface MarkedIssue {
  kind: "box" | "text";
  url: string;
  title: string;
  /** Selected text (text mode) or the visible text in the box. */
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  vw: number;
  element: { path: string; tag: string; html: string; locator: string } | null;
}

export const CANCEL_REPORT_SCRIPT = `if (window.__cruxReportCancel) window.__cruxReportCancel(); return "ok";`;

// Runs in the page's isolated world (shares the DOM, not the page's JS).
// Resolves with JSON of a MarkedIssue, or null on Escape.
export const REPORT_SCRIPT = String.raw`
if (window.__cruxReportCancel) window.__cruxReportCancel();
const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
const q = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const short = (el) => {
  let s = el.tagName.toLowerCase();
  if (el.id) s += "#" + el.id;
  const cls = [...el.classList].filter((c) => !/^(css|sc|jsx|emotion)-|[0-9a-f]{6,}/i.test(c)).slice(0, 2);
  if (cls.length) s += "." + cls.join(".");
  return s;
};
const pathOf = (el) => {
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
    parts.unshift(short(n));
    if (n.id) break;
  }
  return parts.join(" > ");
};
const roleOf = (el) => {
  const r = el.getAttribute("role");
  if (r) return r;
  const t = el.tagName.toLowerCase();
  if (t === "a" && el.hasAttribute("href")) return "link";
  if (t === "button") return "button";
  if (/^h[1-6]$/.test(t)) return "heading";
  if (t === "input" || t === "textarea") return "textbox";
  return "";
};
const locatorOf = (el) => {
  const tid = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
  if (tid) return "page.getByTestId(" + q(tid) + ")";
  const role = roleOf(el);
  const name = clean(el.getAttribute("aria-label") || el.innerText).slice(0, 60);
  if (role && name) return "page.getByRole(" + q(role) + ", { name: " + q(name) + " })";
  if (name && name.length < 40 && !el.children.length) return "page.getByText(" + q(name) + ")";
  return "page.locator(" + q(pathOf(el)) + ")";
};
const describe = (el) => {
  if (!el) return null;
  let html = el.outerHTML.replace(/\s+/g, " ");
  if (html.length > 700) html = html.slice(0, 700) + " …";
  return { path: pathOf(el), tag: el.tagName.toLowerCase(), html, locator: locatorOf(el) };
};
const pack = (kind, rect, text, el) =>
  JSON.stringify({
    kind,
    url: location.href,
    title: document.title,
    text: clean(text).slice(0, 1200),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    vw: window.innerWidth,
    element: describe(el),
  });

return await new Promise((resolve) => {
  const root = document.createElement("div");
  root.setAttribute("data-crux-report", "");
  root.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(10,12,16,.08)";
  const bar = document.createElement("div");
  bar.style.cssText = "position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:#1b1c20;color:#ececee;font:600 12.5px -apple-system,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center;pointer-events:auto";
  bar.innerHTML = '<span style="color:#3ecf8e">●</span><span>Drag a box around the issue</span><button data-t style="all:unset;cursor:pointer;color:#a9abb2;text-decoration:underline">or select text</button><span style="color:#7b7e86">Esc to cancel</span>';
  const box = document.createElement("div");
  // Thin white line; the faint dark halo keeps it visible on white pages.
  box.style.cssText = "position:fixed;border:1px solid #fff;background:rgba(255,255,255,.06);box-shadow:0 0 0 1px rgba(0,0,0,.35);border-radius:3px;display:none;pointer-events:none";
  root.append(box);
  document.documentElement.append(root, bar);

  let start = null;
  const done = (v) => {
    root.remove();
    bar.remove();
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("copy", onCopy, true);
    document.removeEventListener("mouseup", onTextUp, true);
    delete window.__cruxReportCancel;
    resolve(v);
  };
  window.__cruxReportCancel = () => done(null);
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); done(null); }
  };
  // Text mode: the overlay steps aside so the page's text can be selected;
  // releasing the mouse on a selection (or copying it) reports it.
  const fromSelection = () => {
    const sel = window.getSelection();
    const text = sel ? sel.toString() : "";
    if (!text.trim()) return false;
    const range = sel.getRangeAt(0);
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    done(pack("text", range.getBoundingClientRect(), text, el));
    return true;
  };
  const onCopy = () => setTimeout(fromSelection, 0);
  const onTextUp = () => setTimeout(fromSelection, 0);
  bar.querySelector("[data-t]").addEventListener("click", (e) => {
    e.stopPropagation();
    root.style.display = "none";
    bar.children[1].textContent = "Select the text, then release";
    bar.querySelector("[data-t]").remove();
    document.addEventListener("mouseup", onTextUp, true);
  });
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("copy", onCopy, true);

  root.addEventListener("mousedown", (e) => {
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    box.style.display = "block";
  });
  root.addEventListener("mousemove", (e) => {
    if (!start) return;
    const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
    Object.assign(box.style, { left: x + "px", top: y + "px", width: Math.abs(e.clientX - start.x) + "px", height: Math.abs(e.clientY - start.y) + "px" });
  });
  root.addEventListener("mouseup", (e) => {
    if (!start) return;
    let x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
    let w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
    start = null;
    root.style.display = "none";
    bar.style.display = "none";
    // A click (no drag) marks the element under the pointer.
    let el = document.elementFromPoint(x + w / 2, y + h / 2);
    if (w < 6 || h < 6) {
      if (el) { const r = el.getBoundingClientRect(); x = r.x; y = r.y; w = r.width; h = r.height; }
    } else {
      // What was drawn around: the biggest element (almost) entirely inside
      // the box. If nothing fits (box inside one big element), fall back to
      // the smallest element that contains the whole box.
      let best = null, bestArea = 0;
      for (const c of document.body.querySelectorAll("*")) {
        const r = c.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < 16 || area <= bestArea) continue;
        const ix = Math.max(0, Math.min(r.right, x + w) - Math.max(r.left, x));
        const iy = Math.max(0, Math.min(r.bottom, y + h) - Math.max(r.top, y));
        if ((ix * iy) / area >= 0.85) { best = c; bestArea = area; }
      }
      if (best) el = best;
      else while (el && el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.left <= x + 2 && r.top <= y + 2 && r.right >= x + w - 2 && r.bottom >= y + h - 2) break;
        el = el.parentElement;
      }
    }
    const text = el ? el.innerText : "";
    done(pack("box", { x, y, width: w, height: h }, text, el));
  });
});
`;

/**
 * Crop the pane screenshot around the marked area (with some context) and
 * outline it, so the agent sees exactly what was pointed at.
 */
export async function cropShot(pngBase64: string, issue: MarkedIssue): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/png;base64,${pngBase64}`;
  await img.decode();
  const scale = img.naturalWidth / Math.max(1, issue.vw);
  const pad = 60;
  const r = issue.rect;
  const sx = Math.max(0, (r.x - pad) * scale);
  const sy = Math.max(0, (r.y - pad) * scale);
  const sw = Math.min(img.naturalWidth - sx, (r.w + pad * 2) * scale);
  const sh = Math.min(img.naturalHeight - sy, (r.h + pad * 2) * scale);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#e5484d";
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.strokeRect(r.x * scale - sx, r.y * scale - sy, r.w * scale, r.h * scale);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
}

/** Asks the agent to draft, then (after the user's OK) file, a Jira bug for a marked issue. */
export function jiraPrompt(issue: MarkedIssue, shot: string, project: string): string {
  const lines = [
    "File a Jira bug for the issue in the screenshot above.",
    `Page: ${issue.url}${issue.title ? ` (${issue.title})` : ""}`,
  ];
  if (issue.text.trim()) lines.push(`Marked text: "${issue.text.trim().slice(0, 300)}"`);
  if (issue.element?.locator) lines.push(`Element: ${issue.element.locator}`);
  lines.push(
    "",
    "1. Draft it: a short title, steps to reproduce, expected vs actual result, and the page URL. Look at the page or code if you need to.",
    "2. Show me the draft and wait for my OK.",
    `3. Then create it in Jira${project ? ` project ${project}` : " (ask me which project)"} with your Jira / Atlassian tools, attach the screenshot (${shot}), and give me the link.`,
    "If you have no Jira tools, say so and tell me how to connect them.",
  );
  return lines.join("\n");
}
