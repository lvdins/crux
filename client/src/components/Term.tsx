import { useEffect, useRef, useState, type DragEvent } from "react";
import { api } from "../net";
import { IS_MAC } from "../platform";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  APPEARANCE_EVENT,
  SAFE_MODE_KEY,
  resolveLook,
  withDefaults,
  type Appearance,
  type AppearanceEventDetail,
  type ChatKind,
  type TermLook,
} from "../appearance";
import { getScheme, toXtermTheme } from "../terminalThemes";

export type TermSend = (payload: Record<string, unknown>) => void;
export type TermSubscribe = (id: string, handler: (data: string) => void) => () => void;

/** What decides a terminal's look besides the app-wide settings. */
interface TermCtx {
  repo: string;
  kind?: ChatKind;
  look?: TermLook;
}

interface CachedTerm {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  ctx: TermCtx;
  /** Set while mounted: fit + tell the PTY the new size. */
  refit?: () => void;
}

// Terminals live outside React so scrollback and the running program survive
// tab/workspace switches — the DOM node is just re-parented on mount.
const cache = new Map<string, CachedTerm>();

const FONT = '"QL Nerd", "MesloLGS NF", ui-monospace, "SF Mono", Menlo, monospace';
const FONT_SIZE = 12.5;
// Web fonts load lazily; start both weights now so the first terminal
// measures cells with the real glyph metrics.
const fontReady = Promise.all([
  document.fonts?.load('400 12.5px "QL Nerd"'),
  document.fonts?.load('700 12.5px "QL Nerd"'),
]).catch(() => undefined);

// --- Appearance ---------------------------------------------------------
// The latest settings, kept here so terminals created later (and the live
// updates below) read the same thing. Settings write "crux.appearance".
function loadAppearance(): Appearance {
  try {
    if (localStorage.getItem(SAFE_MODE_KEY)) return withDefaults();
    return withDefaults(JSON.parse(localStorage.getItem("crux.appearance") ?? "null"));
  } catch {
    return withDefaults();
  }
}
let appearance = loadAppearance();

/** The appearance terminals currently use. */
export function getAppearance(): Appearance {
  return appearance;
}

// Terminals that show a background behind them (see setTermTransparent).
const transparent = new Set<string>();

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fontOf = () => appearance.font.family?.trim() || FONT;
const sizeOf = () => (appearance.font.size ? clamp(appearance.font.size, 10, 24) : FONT_SIZE);

/** xterm options for a terminal's look. Nothing set → exactly Crux's old options. */
function lookOptions(ctx: TermCtx, id: string): ITerminalOptions {
  const { font } = appearance;
  const scheme = getScheme(resolveLook(appearance, { session: ctx.look, repo: ctx.repo, kind: ctx.kind }).scheme, appearance);
  const theme = toXtermTheme(scheme);
  const clear = transparent.has(id);
  const opts: ITerminalOptions = {
    fontSize: sizeOf(),
    fontFamily: fontOf(),
    cursorBlink: font.cursorBlink ?? true,
    theme: clear ? { ...theme, background: "#00000000" } : theme,
  };
  if (font.lineHeight) opts.lineHeight = clamp(font.lineHeight, 1, 2);
  if (font.cursorStyle) opts.cursorStyle = font.cursorStyle;
  if (clear) opts.allowTransparency = true;
  return opts;
}

// No ligature addon (it needs font files the webview can't read); the DOM
// renderer draws runs of text, so the CSS feature does the job.
function applyLigatures(el: HTMLElement) {
  const on = appearance.font.ligatures;
  el.style.fontVariantLigatures = on ? "normal" : on === false ? "none" : "";
  el.style.fontFeatureSettings = on ? '"liga" 1, "calt" 1' : "";
}

/** Wait for a (possibly new) font so cells are measured with real glyphs. */
async function loadFont(family: string, size: number) {
  try {
    await Promise.all([document.fonts?.load(`400 ${size}px ${family}`), document.fonts?.load(`700 ${size}px ${family}`)]);
  } catch {
    /* unknown font or older webview: the fallback still renders */
  }
}

/** Apply the current look to one terminal; refit when the cell size changes. */
async function restyle(id: string, c: CachedTerm) {
  const next = lookOptions(c.ctx, id);
  const o = c.term.options;
  const metrics = o.fontFamily !== next.fontFamily || o.fontSize !== next.fontSize || (o.lineHeight ?? 1) !== (next.lineHeight ?? 1);
  if (metrics) await loadFont(next.fontFamily!, next.fontSize!);
  if (cache.get(id) !== c) return; // closed meanwhile
  o.theme = next.theme;
  o.cursorBlink = next.cursorBlink;
  o.cursorStyle = next.cursorStyle ?? "block";
  o.allowTransparency = next.allowTransparency ?? false;
  applyLigatures(c.el);
  if (!metrics) return;
  o.fontSize = next.fontSize;
  o.lineHeight = next.lineHeight ?? 1;
  o.fontFamily = next.fontFamily;
  c.refit?.();
}

// Settings saved or previewed: every open terminal changes right away.
window.addEventListener(APPEARANCE_EVENT, (e) => {
  appearance = withDefaults((e as CustomEvent<AppearanceEventDetail>).detail);
  for (const [id, c] of cache) void restyle(id, c);
});

/**
 * Let a background show through a terminal: its background colour becomes
 * transparent (the text colours stay). Works before the terminal exists.
 */
export function setTermTransparent(id: string, on: boolean): void {
  if (on === transparent.has(id)) return;
  if (on) transparent.add(id);
  else transparent.delete(id);
  const c = cache.get(id);
  if (c) void restyle(id, c);
}

/** A terminal's own element (lives across re-mounts), if it's been created. */
export function termEl(id: string): HTMLDivElement | undefined {
  return cache.get(id)?.el;
}

/** Put the keyboard in a terminal (e.g. after adding an image to its input). */
export function focusTerm(id: string): void {
  cache.get(id)?.term.focus();
}

export function disposeTerm(id: string): void {
  const cached = cache.get(id);
  if (cached) {
    cached.term.dispose();
    cached.el.remove();
    cache.delete(id);
  }
}

export default function Term({
  id,
  repo,
  look,
  kind,
  bootCmd,
  connected,
  send,
  subscribe,
  onFocus,
}: {
  /** Called when this terminal gets keyboard focus or is clicked. */
  onFocus?: (id: string) => void;
  id: string;
  repo: string;
  /** This terminal's own look (tab theme); wins over workspace and kind. */
  look?: TermLook;
  kind?: ChatKind;
  bootCmd?: string;
  connected: boolean;
  send: TermSend;
  subscribe: TermSubscribe;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !connected) return;

    let cached = cache.get(id);
    const fresh = !cached;
    if (!cached) {
      const el = document.createElement("div");
      el.style.width = "100%";
      el.style.height = "100%";
      const ctx: TermCtx = { repo, kind, look };
      const term = new Terminal({
        ...lookOptions(ctx, id),
        scrollback: 8000,
        // Glyphs (powerline arrows, icons) drawn edge to edge, no seams.
        customGlyphs: true,
        rescaleOverlappingGlyphs: true,
      });
      applyLigatures(el);
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      // Registered once for the terminal's lifetime — survives re-mounts.
      term.onData((data) => send({ type: "term:input", id, data }));
      // Shift+Enter = new line, not send: Ctrl+J is the newline key Claude
      // Code and Codex both accept in any terminal.
      term.attachCustomKeyEventHandler((e) => {
        // Linux / Windows: Ctrl+Shift+C / V copy and paste (plain Ctrl+C stops the program).
        if (!IS_MAC && e.ctrlKey && e.shiftKey && !e.altKey && (e.code === "KeyC" || e.code === "KeyV")) {
          if (e.type === "keydown") {
            if (e.code === "KeyC") void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
            else void navigator.clipboard?.readText().then((t) => t && term.paste(t)).catch(() => undefined);
          }
          return false;
        }
        if (e.key !== "Enter" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return true;
        if (e.type === "keydown") send({ type: "term:input", id, data: "\n" });
        return false;
      });
      cached = { term, fit, el, ctx };
      cache.set(id, cached);
    }
    const entry = cached;
    const { term, fit, el } = entry;
    container.appendChild(el);

    let disposed = false;
    // Report focus (keyboard or click) so actions can target this terminal.
    const reportFocus = () => onFocusRef.current?.(id);
    term.textarea?.addEventListener("focus", reportFocus);
    container.addEventListener("pointerdown", reportFocus, true);
    let unsubscribe: (() => void) | null = null;
    let lastCols = 0;
    let lastRows = 0;

    const doFit = () => {
      if (disposed) return;
      fit.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        send({ type: "term:resize", id, cols: term.cols, rows: term.rows });
      }
      // Full repaint: fits during pane animations can leave stale glyphs.
      term.refresh(0, term.rows - 1);
    };

    // The PTY must be created with the settled size, or programs like claude
    // draw at the wrong width. Wait for fonts + two frames before opening.
    const boot = async () => {
      try {
        await fontReady;
        await document.fonts?.ready;
      } catch {
        /* older webviews */
      }
      // A font picked in Appearance loads on demand.
      if (fresh && (fontOf() !== FONT || sizeOf() !== FONT_SIZE)) await loadFont(fontOf(), sizeOf());
      // Re-assign so xterm re-measures cells with the now-loaded font.
      if (fresh) term.options.fontFamily = fontOf();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      if (disposed) return;
      fit.fit();
      lastCols = term.cols;
      lastRows = term.rows;
      // bootCmd is sent on every open; the server applies it only when it
      // actually creates the PTY. (StrictMode double-mounts made a
      // fresh-gated bootCmd disappear: the second effect run sees the cached
      // terminal, reports fresh=false, and the server may not have spawned yet.)
      send({ type: "term:open", id, repo, cols: term.cols, rows: term.rows, fresh, bootCmd });
      unsubscribe = subscribe(id, (data) => term.write(data));
      // Live appearance changes may refit from now on (the PTY exists).
      entry.refit = doFit;
      // One more pass shortly after, in case a scrollbar or font swap shifted
      // the layout between the first fit and the PTY spawn.
      setTimeout(doFit, 300);
      // Don't steal focus from an input the user moved to while we booted
      // (e.g. the sidebar rename field).
      const active = document.activeElement;
      if (!active || active === document.body || el.contains(active)) term.focus();
    };
    void boot();

    let debounce: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(debounce);
      debounce = setTimeout(doFit, 80);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(container);
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      if (entry.refit === doFit) entry.refit = undefined;
      term.textarea?.removeEventListener("focus", reportFocus);
      container.removeEventListener("pointerdown", reportFocus, true);
      clearTimeout(debounce);
      unsubscribe?.();
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      if (el.parentElement === container) container.removeChild(el);
    };
  }, [id, repo, bootCmd, connected, send, subscribe]);

  // Tab theme / workspace / kind changed: restyle in place (no re-open).
  const lookKey = JSON.stringify(look ?? null);
  useEffect(() => {
    const c = cache.get(id);
    if (!c) return;
    const ctx: TermCtx = { repo, kind, look };
    if (JSON.stringify(ctx) === JSON.stringify(c.ctx)) return;
    c.ctx = ctx;
    void restyle(id, c);
  }, [id, repo, kind, lookKey, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop screenshots / photos (any file) onto the chat: the server saves them
  // and their paths are pasted in, which is how Claude Code attaches images.
  const [drop, setDrop] = useState<null | "over" | "saving" | "failed">(null);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

  const attach = async (files: File[]) => {
    setDrop("saving");
    try {
      const paths = await Promise.all(
        files.map(async (f) => {
          const r = await api(`/api/attachments?name=${encodeURIComponent(f.name || "image.png")}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: f,
          });
          if (!r.ok) throw new Error(`attach failed: ${r.status}`);
          return ((await r.json()) as { path: string }).path;
        }),
      );
      const term = cache.get(id)?.term;
      if (term) {
        term.paste(paths.map((p) => p.replace(/([^\w/.-])/g, "\\$1")).join(" ") + " ");
        term.focus();
      }
      setDrop(null);
    } catch {
      setDrop("failed");
      setTimeout(() => setDrop(null), 2500);
    }
  };

  return (
    <div
      className="term"
      ref={containerRef}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDrop("over");
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        if (--depth.current <= 0) {
          depth.current = 0;
          setDrop(null);
        }
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        const files = [...e.dataTransfer.files];
        if (files.length) void attach(files);
        else setDrop(null);
      }}
    >
      {drop && (
        <div className={`term-drop ${drop}`}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <circle cx="9" cy="10" r="1.8" />
            <path d="m21 16-5-5-8 9" />
          </svg>
          <span>{drop === "saving" ? "Attaching…" : drop === "failed" ? "Couldn't attach — restart Crux and try again" : "Drop to attach to this chat"}</span>
        </div>
      )}
    </div>
  );
}
