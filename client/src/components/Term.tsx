import { useEffect, useRef } from "react";
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
}: {
  id: string;
  repo: string;
  bootCmd?: string;
  connected: boolean;
  send: TermSend;
  subscribe: TermSubscribe;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

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
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        cursorBlink: true,
        scrollback: 8000,
        theme: {
          background: "#0e0e0e",
          foreground: "#ececec",
          cursor: "#3ecf8e",
          selectionBackground: "#2a2a2a",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      // Registered once for the terminal's lifetime — survives re-mounts.
      term.onData((data) => send({ type: "term:input", id, data }));
      cached = { term, fit, el };
      cache.set(id, cached);
    }
    const { term, fit, el } = cached;
    container.appendChild(el);

    let disposed = false;
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
        await document.fonts?.ready;
      } catch {
        /* older webviews */
      }
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
      term.focus();
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
      clearTimeout(debounce);
      unsubscribe?.();
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      if (el.parentElement === container) container.removeChild(el);
    };
  }, [id, repo, bootCmd, connected, send, subscribe]);

  return <div className="term" ref={containerRef} />;
}
