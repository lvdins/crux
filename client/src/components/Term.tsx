import { useEffect, useRef, useState, type DragEvent } from "react";
import { api } from "../net";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type TermSend = (payload: Record<string, unknown>) => void;
export type TermSubscribe = (id: string, handler: (data: string) => void) => () => void;

interface CachedTerm {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

// Terminals live outside React so scrollback and the running program survive
// tab/workspace switches — the DOM node is just re-parented on mount.
const cache = new Map<string, CachedTerm>();

const FONT = '"QL Nerd", "MesloLGS NF", ui-monospace, "SF Mono", Menlo, monospace';
// Web fonts load lazily; start both weights now so the first terminal
// measures cells with the real glyph metrics.
const fontReady = Promise.all([
  document.fonts?.load('400 12.5px "QL Nerd"'),
  document.fonts?.load('700 12.5px "QL Nerd"'),
]).catch(() => undefined);

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
      const term = new Terminal({
        fontSize: 12.5,
        fontFamily: FONT,
        cursorBlink: true,
        scrollback: 8000,
        // Glyphs (powerline arrows, icons) drawn edge to edge, no seams.
        customGlyphs: true,
        rescaleOverlappingGlyphs: true,
        theme: {
          background: "#1b1c20",
          foreground: "#e6e6e6",
          cursor: "#3ecf8e",
          cursorAccent: "#1b1c20",
          selectionBackground: "#3a4a42",
          black: "#2a2b30",
          red: "#e06c75",
          green: "#3ecf8e",
          yellow: "#e5c07b",
          blue: "#61afef",
          magenta: "#c678dd",
          cyan: "#56b6c2",
          white: "#d4d4d4",
          brightBlack: "#5c6370",
          brightRed: "#ef7f88",
          brightGreen: "#5fe0a6",
          brightYellow: "#f0d08e",
          brightBlue: "#7cc0f5",
          brightMagenta: "#d595e8",
          brightCyan: "#6fcad5",
          brightWhite: "#f5f5f5",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      // Registered once for the terminal's lifetime — survives re-mounts.
      term.onData((data) => send({ type: "term:input", id, data }));
      // Shift+Enter = new line, not send: Ctrl+J is the newline key Claude
      // Code and Codex both accept in any terminal.
      term.attachCustomKeyEventHandler((e) => {
        if (e.key !== "Enter" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return true;
        if (e.type === "keydown") send({ type: "term:input", id, data: "\n" });
        return false;
      });
      cached = { term, fit, el };
      cache.set(id, cached);
    }
    const { term, fit, el } = cached;
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
      // Re-assign so xterm re-measures cells with the now-loaded font.
      if (fresh) term.options.fontFamily = FONT;
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
      term.textarea?.removeEventListener("focus", reportFocus);
      container.removeEventListener("pointerdown", reportFocus, true);
      clearTimeout(debounce);
      unsubscribe?.();
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      if (el.parentElement === container) container.removeChild(el);
    };
  }, [id, repo, bootCmd, connected, send, subscribe]);

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
