import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { browserLabel, setActiveBrowserLabel } from "../agentBrowser";

/**
 * In-app browser with minimal tabs. In the desktop app each tab is a native
 * WebKit view (Tauri child webview) docked over a placeholder div — real
 * cookies, logins stick, no iframe restrictions; only the active tab's view
 * is shown. In a plain browser tab it falls back to an iframe.
 *
 * Native views float above the HTML, so the parent must pass `visible=false`
 * whenever something should be drawn on top (modals, menus, drags).
 */

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T = void>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export interface Bookmark {
  name: string;
  url: string;
}

const DEFAULT_BOOKMARKS: Bookmark[] = [
  { name: "Dashboard", url: "https://dashboard.g360lab.com/" },
  { name: "Console", url: "https://console.g360lab.com/" },
  { name: "Local :3000", url: "http://localhost:3000/" },
];

function loadBookmarks(): Bookmark[] {
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

/** Same page, ignoring query, hash and trailing slash. */
const samePage = (a: string, b: string) => {
  const key = (u: string) => {
    try {
      const x = new URL(u);
      return (x.host + x.pathname).replace(/\/+$/, "");
    } catch {
      return u;
    }
  };
  return key(a) === key(b);
};

const shortTitle = (t: Tab, marks: Bookmark[] = []) => {
  if (t.title) return t.title;
  const mark = marks.find((b) => samePage(b.url, t.url));
  if (mark) return mark.name;
  try {
    return new URL(t.url).host.replace(/^www\./, "");
  } catch {
    return t.url;
  }
};

interface Tab {
  id: number;
  url: string;
  title: string;
}

export default function Browser({
  wsKey,
  visible,
  defaultUrl,
  bookmarks: fixedBookmarks,
  openRequest,
}: {
  wsKey: string;
  visible: boolean;
  defaultUrl?: string;
  /** Replaces the editable bookmark bar (e.g. saved Jira boards). */
  bookmarks?: Bookmark[];
  /** Open this URL: switch to a tab already showing it, else a new tab. */
  openRequest?: { url: string; nonce: number } | null;
}) {
  const tabsKey = `qualitylab.browserTabs.${wsKey}`;
  const startUrl = defaultUrl ?? localStorage.getItem(`qualitylab.browserUrl.${wsKey}`) ?? DEFAULT_BOOKMARKS[0].url;
  const [tabs, setTabs] = useState<Tab[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(tabsKey) ?? "null");
      if (Array.isArray(saved?.tabs) && saved.tabs.length) return saved.tabs;
    } catch {
      /* corrupt */
    }
    return [{ id: 1, url: openRequest?.url ?? startUrl, title: "" }];
  });
  const [activeId, setActiveId] = useState<number>(() => {
    try {
      return JSON.parse(localStorage.getItem(tabsKey) ?? "null")?.active ?? 1;
    } catch {
      return 1;
    }
  });
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const labelFor = useCallback((id: number) => (id === 1 ? browserLabel(wsKey) : `${browserLabel(wsKey)}-t${id}`), [wsKey]);
  const label = labelFor(active.id);

  const [input, setInput] = useState(active.url);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savedBookmarks, setSavedBookmarks] = useState(loadBookmarks);
  const bookmarks = fixedBookmarks ?? savedBookmarks;
  const [frameKey, setFrameKey] = useState(0);
  // Collapse the address bar + bookmarks for more page space (remembered).
  const [chromeHidden, setChromeHidden] = useState(() => localStorage.getItem("qualitylab.browserChrome") === "hidden");
  const toggleChrome = () =>
    setChromeHidden((h) => {
      localStorage.setItem("qualitylab.browserChrome", h ? "shown" : "hidden");
      return !h;
    });
  const slotRef = useRef<HTMLDivElement>(null);
  const opened = useRef(new Set<string>());
  const editing = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Persist tabs; tell the agent bridge which view is the active one.
  useEffect(() => {
    localStorage.setItem(tabsKey, JSON.stringify({ tabs, active: active.id }));
    localStorage.setItem(`qualitylab.browserUrl.${wsKey}`, active.url);
    setActiveBrowserLabel(wsKey, label);
  }, [tabs, active.id, active.url, tabsKey, wsKey, label]);

  useEffect(() => {
    if (!editing.current) setInput(active.url);
  }, [active.id, active.url]);

  const updateTab = useCallback((id: number, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // Native view placement: follow the placeholder's box every frame it moves.
  const place = useCallback(() => {
    const el = slotRef.current;
    if (!isTauri || !el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) {
      void invoke("browser_hide", { label });
      return;
    }
    void invoke("browser_show", {
      label,
      url: activeRef.current.url,
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      viewportHeight: window.innerHeight,
    })
      .then(() => {
        opened.current.add(label);
        setError("");
      })
      .catch((err) => setError(String(err)));
  }, [label]);

  useLayoutEffect(() => {
    if (!isTauri) return;
    if (!visible) {
      void invoke("browser_hide", { label });
      return;
    }
    let raf = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    // WebKit child views are positioned from the window's bottom edge; if we
    // place during a window resize, macOS may still report the old height and
    // the view lands too high (white gap underneath). Re-place once the native
    // resize has settled.
    const settle = () => {
      schedule();
      timers.push(setTimeout(schedule, 150), setTimeout(schedule, 500));
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    if (slotRef.current) ro.observe(slotRef.current);
    window.addEventListener("resize", settle);
    let unlistenNative: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      Promise.all([getCurrentWindow().onResized(settle), getCurrentWindow().onScaleChanged(settle)]).then((fns) => {
        if (disposed) fns.forEach((fn) => fn());
        else unlistenNative = () => fns.forEach((fn) => fn());
      }),
    );
    // Panel slides move the box without resizing it — catch those too.
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("transitionrun", schedule, true);
    return () => {
      disposed = true;
      unlistenNative?.();
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", settle);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("transitionrun", schedule, true);
      void invoke("browser_hide", { label });
    };
  }, [visible, label, place]);

  // URL / loading / title updates from every tab's native view.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ label: string; url: string; loading: boolean }>("browser:nav", (e) => {
        const tab = tabsRef.current.find((t) => labelFor(t.id) === e.payload.label);
        if (!tab) return;
        if (tab.id === activeRef.current.id) setLoading(e.payload.loading);
        updateTab(tab.id, { url: e.payload.url });
        if (!e.payload.loading) {
          void invoke<string>("browser_js", { label: e.payload.label, script: "return document.title" })
            .then((title) => updateTab(tab.id, { title: title.slice(0, 80) }))
            .catch(() => undefined);
        }
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [labelFor, updateTab]);

  const go = (target: string) => {
    const next = normalise(target);
    if (!next) return;
    updateTab(active.id, { url: next, title: "" });
    setInput(next);
    if (!isTauri) {
      setFrameKey((k) => k + 1);
      return;
    }
    if (opened.current.has(label)) void invoke("browser_navigate", { label, url: next }).catch((err) => setError(String(err)));
    else place();
  };

  const addTab = useCallback(
    (url: string) => {
      const id = Math.max(0, ...tabsRef.current.map((t) => t.id)) + 1;
      setTabs((prev) => [...prev, { id, url, title: "" }]);
      setActiveId(id);
    },
    [],
  );

  const closeTab = (id: number) => {
    const l = labelFor(id);
    if (isTauri) void invoke("browser_close", { label: l }).catch(() => undefined);
    opened.current.delete(l);
    const idx = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    if (rest.length === 0) {
      const fresh = Math.max(...tabs.map((t) => t.id)) + 1;
      setTabs([{ id: fresh, url: defaultUrl ?? DEFAULT_BOOKMARKS[0].url, title: "" }]);
      setActiveId(fresh);
      return;
    }
    setTabs(rest);
    if (id === active.id) setActiveId(rest[Math.min(idx, rest.length - 1)].id);
  };

  // External "open this" (Jira boards): reuse a tab already on that page.
  const lastNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest || openRequest.nonce === lastNonce.current) return;
    lastNonce.current = openRequest.nonce;
    const existing = tabsRef.current.find((t) => samePage(t.url, openRequest.url));
    if (existing) setActiveId(existing.id);
    else addTab(openRequest.url);
  }, [openRequest, addTab]);

  const action = (name: "back" | "forward" | "reload") => {
    if (isTauri) void invoke("browser_action", { label, action: name }).catch((err) => setError(String(err)));
    else if (name === "reload") setFrameKey((k) => k + 1);
  };

  const isBookmarked = bookmarks.some((b) => b.url === active.url);
  const toggleBookmark = () => {
    const next = isBookmarked
      ? savedBookmarks.filter((b) => b.url !== active.url)
      : [...savedBookmarks, { name: shortTitle({ ...active, title: "" }), url: active.url }];
    setSavedBookmarks(next);
    localStorage.setItem("qualitylab.bookmarks", JSON.stringify(next));
  };

  return (
    <div className="browser">
      <div className="browser-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`browser-tab ${t.id === active.id ? "on" : ""}`}
            title={t.url}
            onClick={() => setActiveId(t.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
          >
            <span>{shortTitle(t, bookmarks)}</span>
            <button
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="browser-tab-add" title="New tab" onClick={() => addTab(defaultUrl ?? bookmarks[0]?.url ?? DEFAULT_BOOKMARKS[0].url)}>
          +
        </button>
        <button
          className={`browser-chrome-toggle ${chromeHidden ? "collapsed" : ""}`}
          title={chromeHidden ? "Show address bar" : "Hide address bar"}
          onClick={toggleChrome}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7.5L6 4.5L9 7.5" />
          </svg>
        </button>
      </div>
      <div className={`browser-chrome ${chromeHidden ? "collapsed" : ""}`}>
      <div className="browser-chrome-inner">
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
              setInput(activeRef.current.url);
            }}
            onChange={(e) => setInput(e.target.value)}
          />
        </form>
        {!fixedBookmarks && (
          <button title={isBookmarked ? "Remove bookmark" : "Bookmark this page"} onClick={toggleBookmark} className={isBookmarked ? "on" : ""}>
            {isBookmarked ? "★" : "☆"}
          </button>
        )}
      </div>
      {bookmarks.length > 0 && (
        <div className="browser-marks">
          {bookmarks.map((b) => (
            <button key={b.url} className={samePage(active.url, b.url) ? "on" : ""} onClick={() => go(b.url)} title={b.url}>
              {b.name}
            </button>
          ))}
        </div>
      )}
      </div>
      </div>
      {loading && <div className="browser-progress" />}
      {error && <div className="browser-error">{error}</div>}
      <div className="browser-slot" ref={slotRef}>
        {!isTauri && <iframe key={`${active.id}-${frameKey}`} src={active.url} title="Browser" />}
        {isTauri && !visible && <div className="browser-paused">Browser hidden while an overlay is open</div>}
      </div>
    </div>
  );
}
