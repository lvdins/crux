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
    fit.fit();
    send({ type: "term:open", repo, cols: term.cols, rows: term.rows, fresh });
    const unsubscribe = subscribe(repo, (data) => term.write(data));

    const resize = () => {
      fit.fit();
      send({ type: "term:resize", repo, cols: term.cols, rows: term.rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    term.focus();

    return () => {
      unsubscribe();
      observer.disconnect();
      if (el.parentElement === container) container.removeChild(el);
    };
  }, [repo, connected, send, subscribe]);

  return <div className="term" ref={containerRef} />;
}
