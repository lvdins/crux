import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type TermSend = (payload: Record<string, unknown>) => void;
export type TermSubscribe = (repo: string, handler: (data: string) => void) => () => void;

interface CachedTerm {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

// Terminals live outside React so scrollback and the running program survive
// workspace switches — the DOM node is just re-parented on mount.
const cache = new Map<string, CachedTerm>();

export default function Term({
  repo,
  connected,
  send,
  subscribe,
}: {
  repo: string;
  connected: boolean;
  send: TermSend;
  subscribe: TermSubscribe;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !connected) return;

    let cached = cache.get(repo);
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
          background: "#101511",
          foreground: "#e4eae5",
          cursor: "#2fc98f",
          selectionBackground: "#15362a",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      // Registered once for the terminal's lifetime — survives re-mounts.
      term.onData((data) => send({ type: "term:input", repo, data }));
      cached = { term, fit, el };
      cache.set(repo, cached);
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
        send({ type: "term:resize", repo, cols: term.cols, rows: term.rows });
      }
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
      send({ type: "term:open", repo, cols: term.cols, rows: term.rows, fresh });
      unsubscribe = subscribe(repo, (data) => term.write(data));
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
  }, [repo, connected, send, subscribe]);

  return <div className="term" ref={containerRef} />;
}
