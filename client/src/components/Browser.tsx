import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { browserLabel } from "../agentBrowser";

/**
 * Browser tab for the right panel. In the desktop app it docks a native
 * WebKit view (Tauri child webview) over a placeholder div — real cookies,
 * logins stick, no iframe restrictions. In a plain browser tab it falls
 * back to an iframe.
 *
 * Native views float above the HTML, so the parent must pass `visible=false`
 * whenever something should be drawn on top (modals, menus, drags).
 */

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T = void>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

const DEFAULT_BOOKMARKS = [
  { name: "Dashboard", url: "https://dashboard.g360lab.com/" },
  { name: "Console", url: "https://console.g360lab.com/" },
  { name: "Local :3000", url: "http://localhost:3000/" },
];

function loadBookmarks(): { name: string; url: string }[] {
  try {
    const saved = JSON.parse(localStorage.getItem("qualitylab.bookmarks") ?? "null");
    if (Array.isArray(saved)) return saved;
  } catch {
    /* corrupt */
  }
  return DEFAULT_BOOKMARKS;
}

function normalise(input: string): string {
  const t = input.trim();
  if (!t) return t;
  if (/^[a-z]+:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

export default function Browser({ wsKey, visible }: { wsKey: string; visible: boolean }) {
  const label = browserLabel(wsKey);
  const storeKey = `qualitylab.browserUrl.${wsKey}`;
  const [url, setUrl] = useState(() => localStorage.getItem(storeKey) ?? DEFAULT_BOOKMARKS[0].url);
  const [input, setInput] = useState(url);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [bookmarks, setBookmarks] = useState(loadBookmarks);
  const [frameKey, setFrameKey] = useState(0);
  const slotRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const editing = useRef(false);
  const urlRef = useRef(url);

  const remember = useCallback(
    (next: string) => {
      setUrl(next);
      urlRef.current = next;
      if (!editing.current) setInput(next);
      localStorage.setItem(storeKey, next);
    },
    [storeKey],
  );

  // Native view placement: follow the placeholder's box every frame it moves.
  const place = useCallback(() => {
    const el = slotRef.current;
    if (!isTauri || !el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) {
      void invoke("browser_hide", { label });
      return;
    }
    void invoke("browser_show", { label, url: urlRef.current, x: r.left, y: r.top, width: r.width, height: r.height })
      .then(() => {
        opened.current = true;
        setError("");
      })
      .catch((err) => setError(String(err)));
    // url only matters for the first open; later calls just move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  useLayoutEffect(() => {
    if (!isTauri) return;
    if (!visible) {
      void invoke("browser_hide", { label });
      return;
    }
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    if (slotRef.current) ro.observe(slotRef.current);
    window.addEventListener("resize", schedule);
    // Panel slides move the box without resizing it — catch those too.
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("transitionrun", schedule, true);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("transitionrun", schedule, true);
      void invoke("browser_hide", { label });
    };
  }, [visible, label, place]);

  // URL / loading updates from the native view.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ label: string; url: string; loading: boolean }>("browser:nav", (e) => {
        if (e.payload.label !== label) return;
        setLoading(e.payload.loading);
        remember(e.payload.url);
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [label, remember]);

  const go = (target: string) => {
    const next = normalise(target);
    if (!next) return;
    remember(next);
    setInput(next);
    if (!isTauri) {
      setFrameKey((k) => k + 1);
      return;
    }
    if (opened.current) void invoke("browser_navigate", { label, url: next }).catch((err) => setError(String(err)));
    else place();
  };

  const action = (name: "back" | "forward" | "reload") => {
    if (isTauri) void invoke("browser_action", { label, action: name }).catch((err) => setError(String(err)));
    else if (name === "reload") setFrameKey((k) => k + 1);
  };

  const isBookmarked = bookmarks.some((b) => b.url === url);
  const toggleBookmark = () => {
    const next = isBookmarked
      ? bookmarks.filter((b) => b.url !== url)
      : [...bookmarks, { name: new URL(url).host.replace(/^www\./, "") || url, url }];
    setBookmarks(next);
    localStorage.setItem("qualitylab.bookmarks", JSON.stringify(next));
  };

  return (
    <div className="browser">
      <div className="browser-bar">
        <button title="Back" onClick={() => action("back")} disabled={!isTauri}>
          ‹
        </button>
        <button title="Forward" onClick={() => action("forward")} disabled={!isTauri}>
          ›
        </button>
        <button title="Reload" onClick={() => action("reload")} className={loading ? "spin" : ""}>
          ↻
        </button>
        <form
          className="browser-url"
          onSubmit={(e) => {
            e.preventDefault();
            editing.current = false;
            go(input);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <input
            value={input}
            spellCheck={false}
            onFocus={(e) => {
              editing.current = true;
              e.currentTarget.select();
            }}
            onBlur={() => {
              editing.current = false;
              setInput(urlRef.current);
            }}
            onChange={(e) => setInput(e.target.value)}
          />
        </form>
        <button title={isBookmarked ? "Remove bookmark" : "Bookmark this page"} onClick={toggleBookmark} className={isBookmarked ? "on" : ""}>
          {isBookmarked ? "★" : "☆"}
        </button>
      </div>
      <div className="browser-marks">
        {bookmarks.map((b) => (
          <button key={b.url} className={url.startsWith(b.url) ? "on" : ""} onClick={() => go(b.url)} title={b.url}>
            {b.name}
          </button>
        ))}
      </div>
      {loading && <div className="browser-progress" />}
      {error && <div className="browser-error">{error}</div>}
      <div className="browser-slot" ref={slotRef}>
        {!isTauri && <iframe key={frameKey} src={url} title="Browser" />}
        {isTauri && !visible && <div className="browser-paused">Browser hidden while an overlay is open</div>}
      </div>
    </div>
  );
}
