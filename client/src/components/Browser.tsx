import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_BROWSER_URL, browserLabel, setActiveBrowserLabel } from "../agentBrowser";
import ContextMenu, { MenuIcons, type MenuItem } from "./ContextMenu";
import { CANCEL_PICK_SCRIPT, PICK_SCRIPT, type PickedElement } from "../elementPicker";
import NetworkPanel from "./NetworkPanel";
import { GuardBar, guardStore, useGuard, useGuardWatch, type GuardLeak } from "./WriteGuard";

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

const DEFAULT_BOOKMARKS: Bookmark[] = [{ name: "Local :3000", url: "http://localhost:3000/" }];

function loadBookmarks(): Bookmark[] {
  try {
    const saved = JSON.parse(localStorage.getItem("crux.bookmarks") ?? "null");
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
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
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
  if (t.name) return t.name;
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
  /** Your own name for the tab (double-click to rename); else the page title. */
  name?: string;
  /** Page zoom (1 = actual size). */
  zoom?: number;
}

export default function Browser({
  wsKey,
  visible,
  defaultUrl,
  bookmarks: fixedBookmarks,
  openRequest,
  network = true,
  picker = true,
  writeGuard = false,
  guardWs,
}: {
  /** Settings: show the network-calls dock / the element picker / the write guard. */
  network?: boolean;
  picker?: boolean;
  writeGuard?: boolean;
  /** Workspace the write guard logs under (default: wsKey). */
  guardWs?: string;
  wsKey: string;
  visible: boolean;
  defaultUrl?: string;
  /** Replaces the editable bookmark bar (e.g. saved Jira boards). */
  bookmarks?: Bookmark[];
  /** Open this URL: switch to a tab already showing it, else a new tab. */
  openRequest?: { url: string; nonce: number } | null;
}) {
  const tabsKey = `crux.browserTabs.${wsKey}`;
  const startUrl = defaultUrl ?? localStorage.getItem(`crux.browserUrl.${wsKey}`) ?? DEFAULT_BROWSER_URL;
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
  // Element picker + Web Inspector.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [netOpen, setNetOpen] = useState(() => localStorage.getItem("crux.netOpen") === "1");
  // Settings can switch the network dock off entirely.
  const showNet = network && netOpen;
  const [netHeight, setNetHeight] = useState(() => Number(localStorage.getItem("crux.netHeight")) || 220);
  const [netDragging, setNetDragging] = useState(false);
  // Write guard (see WriteGuard.tsx): one for every pane, off with its setting.
  const guard = useGuard();
  const [leak, setLeak] = useState<GuardLeak | null>(null);
  useEffect(() => {
    if (isTauri) guardStore.enable(writeGuard);
  }, [writeGuard]);
  const guardWatch = useGuardWatch(label, guardWs ?? wsKey, isTauri && visible, (l) => {
    setLeak(l);
    if (network) setNetOpen(true);
  });
  const toggleNet = () =>
    setNetOpen((o) => {
      localStorage.setItem("crux.netOpen", o ? "0" : "1");
      return !o;
    });
  const startNetResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = netHeight;
    setNetDragging(true);
    const move = (ev: PointerEvent) => setNetHeight(Math.min(window.innerHeight * 0.7, Math.max(110, startH + (startY - ev.clientY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setNetDragging(false);
      setNetHeight((h) => {
        localStorage.setItem("crux.netHeight", String(Math.round(h)));
        return h;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // Collapse the address bar + bookmarks for more page space (remembered).
  const [chromeHidden, setChromeHidden] = useState(() => localStorage.getItem("crux.browserChrome") === "hidden");
  const toggleChrome = () =>
    setChromeHidden((h) => {
      localStorage.setItem("crux.browserChrome", h ? "shown" : "hidden");
      return !h;
    });
  const slotRef = useRef<HTMLDivElement>(null);
  const opened = useRef(new Set<string>());
  const editing = useRef(false);
  const urlRef = useRef<HTMLInputElement>(null);
  // Tab being renamed (double-click), and the name typed so far.
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  // Bookmark being renamed (by URL).
  const [renamingMark, setRenamingMark] = useState<{ url: string; name: string } | null>(null);
  // Right-click menu on a tab or bookmark. The page is a native view drawn on
  // top of everything, so it steps aside while a menu is open.
  const [menu, setMenu] = useState<{ x: number; y: number; groups: MenuItem[][] } | null>(null);
  // ⌘F find bar.
  const [find, setFind] = useState<string | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  // Recently closed tabs, for ⌘⇧T.
  const closedTabs = useRef<{ url: string; name?: string }[]>([]);
  // Latest download (saved to ~/Downloads by the native side).
  const [download, setDownload] = useState<{ state: "started" | "done" | "failed"; name: string; path?: string } | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let hide: ReturnType<typeof setTimeout>;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ state: "started" | "done" | "failed"; name: string; path?: string }>("browser:download", (e) => {
        clearTimeout(hide);
        setDownload(e.payload);
        if (e.payload.state !== "started") hide = setTimeout(() => setDownload(null), 12_000);
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      }),
    );
    return () => {
      cancelled = true;
      clearTimeout(hide);
      unlisten?.();
    };
  }, []);
  // Tab / bookmark being dragged to a new place.
  const dragTab = useRef<number | null>(null);
  const dragMark = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Persist tabs; tell the agent bridge which view is the active one.
  useEffect(() => {
    localStorage.setItem(tabsKey, JSON.stringify({ tabs, active: active.id }));
    // Let the sidebar list this browser's tabs (Jira shows them).
    window.dispatchEvent(new CustomEvent("ql:browser-tabs", { detail: { wsKey, tabs, active: active.id } }));
    localStorage.setItem(`crux.browserUrl.${wsKey}`, active.url);
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

  const pageShown = visible && !menu;
  useLayoutEffect(() => {
    if (!isTauri) return;
    if (!pageShown) {
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
  }, [pageShown, label, place]);

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

  const closeTabRef = useRef<(id: number) => void>(() => {});
  const closeTab = (id: number) => {
    const gone = tabs.find((t) => t.id === id);
    if (gone) closedTabs.current = [...closedTabs.current.slice(-19), { url: gone.url, name: gone.name }];
    const l = labelFor(id);
    if (isTauri) void invoke("browser_close", { label: l }).catch(() => undefined);
    opened.current.delete(l);
    const idx = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    if (rest.length === 0) {
      const fresh = Math.max(...tabs.map((t) => t.id)) + 1;
      setTabs([{ id: fresh, url: defaultUrl ?? DEFAULT_BROWSER_URL, title: "" }]);
      setActiveId(fresh);
      return;
    }
    setTabs(rest);
    if (id === active.id) setActiveId(rest[Math.min(idx, rest.length - 1)].id);
  };
  closeTabRef.current = closeTab;

  // ⌘T: a new Google tab with the address bar ready; ⌘L: the address bar.
  const focusUrl = () =>
    setTimeout(() => {
      urlRef.current?.focus();
      urlRef.current?.select();
    }, 60);
  const keyRef = useRef<(op: string) => void>(() => {});
  const setZoom = (tab: Tab, zoom: number) => {
    const z = Math.round(Math.min(3, Math.max(0.3, zoom)) * 100) / 100;
    updateTab(tab.id, { zoom: z === 1 ? undefined : z });
    if (isTauri) void invoke("browser_zoom", { label: labelFor(tab.id), scale: z }).catch(() => undefined);
  };
  const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const stepZoom = (dir: 1 | -1) => {
    const now = active.zoom ?? 1;
    const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.001) : [...ZOOMS].reverse().find((z) => z < now - 0.001);
    if (next) setZoom(active, next);
  };
  const duplicate = (t: Tab) => {
    const id = Math.max(0, ...tabsRef.current.map((x) => x.id)) + 1;
    setTabs((prev) => {
      const i = prev.findIndex((x) => x.id === t.id);
      const next = [...prev];
      next.splice(i + 1, 0, { id, url: t.url, title: t.title, name: t.name });
      return next;
    });
    setActiveId(id);
  };
  const showTab = (i: number) => {
    const t = tabsRef.current[(i + tabsRef.current.length) % tabsRef.current.length];
    if (t) setActiveId(t.id);
  };
  keyRef.current = (op) => {
    if (!visible) return;
    const at = tabs.findIndex((t) => t.id === active.id);
    if (op === "new-tab" || op === "url") {
      if (op === "new-tab") addTab(defaultUrl ?? DEFAULT_BROWSER_URL);
      if (chromeHidden) toggleChrome();
      focusUrl();
    } else if (op === "reopen") {
      const last = closedTabs.current.pop();
      if (last) {
        addTab(last.url);
        if (last.name) setTimeout(() => updateTab(Math.max(...tabsRef.current.map((t) => t.id)), { name: last.name }), 0);
      }
    } else if (op === "close") closeTab(active.id);
    else if (op === "reload" || op === "back" || op === "forward") action(op);
    else if (op === "find") {
      setFind((f) => f ?? "");
      setTimeout(() => {
        findRef.current?.focus();
        findRef.current?.select();
      }, 30);
    } else if (op === "bookmark") toggleBookmark();
    else if (op === "duplicate") duplicate(active);
    else if (op === "zoom-in") stepZoom(1);
    else if (op === "zoom-out") stepZoom(-1);
    else if (op === "zoom-reset") setZoom(active, 1);
    else if (op === "next-tab" || op === "next-tab-ctrl") showTab(at + 1);
    else if (op === "prev-tab" || op === "prev-tab-ctrl") showTab(at - 1);
    else if (op.startsWith("tab-")) {
      const n = Number(op.slice(4));
      showTab(n === 9 ? tabs.length - 1 : n - 1);
    }
  };
  const runFind = (backwards = false) => {
    if (!find || !isTauri) return;
    const script = `return window.find(${JSON.stringify(find)}, false, ${backwards}, true, false, false, false)`;
    void invoke("browser_js", { label, script }).catch(() => undefined);
  };
  const closeFind = () => {
    setFind(null);
    if (isTauri) void invoke("browser_js", { label, script: "window.getSelection()?.removeAllRanges(); return true" }).catch(() => undefined);
  };
  // A tab's zoom comes back when its page view is (re)created.
  useEffect(() => {
    if (isTauri && active.zoom) void invoke("browser_zoom", { label, scale: active.zoom }).catch(() => undefined);
  }, [label, active.zoom, active.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabMenu = (e: React.MouseEvent, t: Tab) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      groups: [
        [
          { label: "Rename", icon: MenuIcons.rename, onSelect: () => setRenaming({ id: t.id, name: t.name ?? shortTitle(t, bookmarks) }) },
          { label: "Duplicate", icon: MenuIcons.copy, onSelect: () => duplicate(t), shortcut: "⌘⇧D" },
          { label: "Reload", icon: MenuIcons.read, onSelect: () => (t.id === active.id ? action("reload") : setActiveId(t.id)) },
          { label: "Copy link", icon: MenuIcons.copy, onSelect: () => copy(t.url) },
        ],
        [
          { label: "Close tab", icon: MenuIcons.remove, onSelect: () => closeTab(t.id), shortcut: "⌘W" },
          ...(tabs.length > 1
            ? [{ label: "Close other tabs", icon: MenuIcons.trash, danger: true, onSelect: () => tabs.filter((x) => x.id !== t.id).forEach((x) => closeTabRef.current(x.id)) }]
            : []),
        ],
      ],
    });
  };
  const saveMarks = (next: Bookmark[]) => {
    setSavedBookmarks(next);
    localStorage.setItem("crux.bookmarks", JSON.stringify(next));
  };
  const finishMarkRename = () => {
    if (!renamingMark) return;
    const name = renamingMark.name.trim();
    if (name) saveMarks(savedBookmarks.map((b) => (b.url === renamingMark.url ? { ...b, name } : b)));
    setRenamingMark(null);
  };
  const markMenu = (e: React.MouseEvent, b: Bookmark) => {
    e.preventDefault();
    if (fixedBookmarks) return;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      groups: [
        [
          { label: "Open in new tab", icon: MenuIcons.copy, onSelect: () => addTab(b.url) },
          { label: "Rename", icon: MenuIcons.rename, onSelect: () => setRenamingMark({ url: b.url, name: b.name }) },
          { label: "Copy link", icon: MenuIcons.copy, onSelect: () => copy(b.url) },
        ],
        [{ label: "Delete bookmark", icon: MenuIcons.trash, danger: true, onSelect: () => saveMarks(savedBookmarks.filter((x) => x.url !== b.url)) }],
      ],
    });
  };
  const moveTab = (from: number, to: number) =>
    setTabs((prev) => {
      const a = prev.findIndex((t) => t.id === from);
      const b = prev.findIndex((t) => t.id === to);
      if (a < 0 || b < 0 || a === b) return prev;
      const next = [...prev];
      const [t] = next.splice(a, 1);
      next.splice(b, 0, t);
      return next;
    });
  const moveMark = (from: string, to: string) => {
    const a = savedBookmarks.findIndex((m) => m.url === from);
    const b = savedBookmarks.findIndex((m) => m.url === to);
    if (a < 0 || b < 0 || a === b) return;
    const next = [...savedBookmarks];
    const [m] = next.splice(a, 1);
    next.splice(b, 0, m);
    saveMarks(next);
  };
  useEffect(() => {
    const onKey = (e: Event) => keyRef.current(String((e as CustomEvent<string>).detail));
    window.addEventListener("ql:browser-key", onKey);
    return () => window.removeEventListener("ql:browser-key", onKey);
  }, []);

  const finishRename = () => {
    if (!renaming) return;
    updateTab(renaming.id, { name: renaming.name.trim() || undefined });
    setRenaming(null);
  };

  // Sidebar asks to activate / close one of our tabs.
  useEffect(() => {
    const onCmd = (e: Event) => {
      const d = (e as CustomEvent<{ wsKey: string; op: "activate" | "close"; id: number }>).detail;
      if (d.wsKey !== wsKey) return;
      if (d.op === "activate") setActiveId(d.id);
      else closeTabRef.current(d.id);
    };
    window.addEventListener("ql:browser-cmd", onCmd);
    return () => window.removeEventListener("ql:browser-cmd", onCmd);
  }, [wsKey]);

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

  const togglePicker = async () => {
    if (!isTauri) return;
    if (picking) {
      void invoke("browser_js", { label, script: CANCEL_PICK_SCRIPT }).catch(() => undefined);
      return;
    }
    setPicking(true);
    setPicked(null);
    try {
      const raw = await invoke<string>("browser_js", { label, script: PICK_SCRIPT, timeoutSecs: 600 });
      const info = JSON.parse(raw) as PickedElement | null;
      if (info) setPicked(info);
    } catch (err) {
      setError(String(err));
    } finally {
      setPicking(false);
    }
  };

  const toggleDevtools = () => {
    if (!isTauri) return;
    void invoke<boolean>("browser_devtools", { label })
      .then((open) => {
        setDevtoolsOpen(open);
        // Snap the page back into the panel in case WebKit moved it.
        place();
        setTimeout(place, 300);
        setTimeout(place, 1000);
      })
      .catch((err) => setError(String(err)));
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1200);
  };

  // A different tab or page invalidates the picked element.
  useEffect(() => setPicked(null), [active.id]);

  const isBookmarked = bookmarks.some((b) => b.url === active.url);
  const toggleBookmark = () => {
    const next = isBookmarked
      ? savedBookmarks.filter((b) => b.url !== active.url)
      : [...savedBookmarks, { name: shortTitle({ ...active, title: "" }), url: active.url }];
    setSavedBookmarks(next);
    localStorage.setItem("crux.bookmarks", JSON.stringify(next));
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
            onDoubleClick={() => setRenaming({ id: t.id, name: t.name ?? shortTitle(t, bookmarks) })}
            onContextMenu={(e) => tabMenu(e, t)}
            draggable={renaming?.id !== t.id}
            onDragStart={(e) => {
              dragTab.current = t.id;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => dragTab.current !== null && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragTab.current !== null) moveTab(dragTab.current, t.id);
              dragTab.current = null;
            }}
            onDragEnd={() => (dragTab.current = null)}
          >
            {renaming?.id === t.id ? (
              <input
                className="browser-tab-rename"
                value={renaming.name}
                autoFocus
                spellCheck={false}
                placeholder="Tab name (empty: page title)"
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenaming({ id: t.id, name: e.target.value })}
                onBlur={finishRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") finishRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span title="Double-click to rename">{shortTitle(t, bookmarks)}</span>
            )}
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
        <button
          className="browser-tab-add"
          title="New tab (⌘T)"
          onClick={() => {
            addTab(defaultUrl ?? DEFAULT_BROWSER_URL);
            focusUrl();
          }}
        >
          +
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
            ref={urlRef}
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
          {active.zoom && (
            <button type="button" className="browser-zoom" title="Reset zoom (⌘0)" onClick={() => setZoom(active, 1)}>
              {Math.round(active.zoom * 100)}%
            </button>
          )}
        </form>
        {picker && (
        <button
          title={picking ? "Cancel inspecting (Esc)" : "Inspect an element: pick it on the page to get Playwright locators"}
          onClick={() => void togglePicker()}
          className={`browser-tool ${picking ? "on" : ""}`}
          disabled={!isTauri}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10" />
            <circle cx="8" cy="8" r="1.6" />
          </svg>
        </button>
        )}
        {network && (
        <button
          title={netOpen ? "Hide network calls" : "Show network calls (fetch / XHR)"}
          onClick={toggleNet}
          className={`browser-tool ${netOpen ? "on" : ""}`}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 2.5v9M2.5 9 5 11.5 7.5 9M11 13.5v-9M8.5 7 11 4.5 13.5 7" />
          </svg>
        </button>
        )}
        {writeGuard && isTauri && (
        <button
          title={guard.on ? "Write guard on: writes to lab / preview hosts are answered by Crux unless granted. Click to turn off." : "Write guard off: click to answer writes to lab / preview hosts in Crux"}
          onClick={() => guardStore.set({ on: !guard.on })}
          className={`browser-tool ${guard.on ? "on" : ""} ${leak ? "guard-leaked" : ""}`}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.6L8 1.8Z" />
            {guard.on && <path d="m5.8 8 1.6 1.6 3-3.2" />}
          </svg>
        </button>
        )}
        {!fixedBookmarks && (
          <button title={isBookmarked ? "Remove bookmark" : "Bookmark this page"} onClick={toggleBookmark} className={isBookmarked ? "on" : ""}>
            {isBookmarked ? "★" : "☆"}
          </button>
        )}
      </div>
      {bookmarks.length > 0 && (
        <div className="browser-marks">
          {bookmarks.map((b) =>
            renamingMark?.url === b.url ? (
              <input
                key={b.url}
                className="browser-tab-rename"
                value={renamingMark.name}
                autoFocus
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setRenamingMark({ url: b.url, name: e.target.value })}
                onBlur={finishMarkRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") finishMarkRename();
                  if (e.key === "Escape") setRenamingMark(null);
                }}
              />
            ) : (
              <button
                key={b.url}
                className={samePage(active.url, b.url) ? "on" : ""}
                onClick={(e) => (e.metaKey || e.ctrlKey ? addTab(b.url) : go(b.url))}
                onAuxClick={(e) => e.button === 1 && addTab(b.url)}
                onDoubleClick={() => !fixedBookmarks && setRenamingMark({ url: b.url, name: b.name })}
                onContextMenu={(e) => markMenu(e, b)}
                title={`${b.url}\nRight-click to rename or delete · ⌘-click: new tab`}
                draggable={!fixedBookmarks}
                onDragStart={() => (dragMark.current = b.url)}
                onDragOver={(e) => dragMark.current !== null && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragMark.current) moveMark(dragMark.current, b.url);
                  dragMark.current = null;
                }}
                onDragEnd={() => (dragMark.current = null)}
              >
                {b.name}
              </button>
            ),
          )}
        </div>
      )}
      </div>
      </div>
      <div className="browser-handle">
        <button onClick={toggleChrome} title={chromeHidden ? "Show address bar" : "Hide address bar"} className={chromeHidden ? "collapsed" : ""}>
          <svg width="12" height="8" viewBox="0 0 12 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 5.5 6 2.5l3 3" />
          </svg>
        </button>
      </div>
      {writeGuard && <GuardBar {...guardWatch} leak={showNet ? null : leak} />}
      {picking && <div className="browser-picking">Hover the page and click an element · Esc to cancel</div>}
      {picked && (
        <div className="browser-picked">
          <div className="picked-head">
            <code className="picked-tag">
              {picked.tag}
              {picked.id && <span>#{picked.id}</span>}
              {picked.classes.slice(0, 2).map((c) => (
                <span key={c}>.{c}</span>
              ))}
            </code>
            {picked.role && (
              <span className="picked-meta">
                {picked.role}
                {picked.name ? ` "${picked.name.slice(0, 40)}"` : ""}
              </span>
            )}
            <span className="picked-meta">{picked.size}</span>
            <button className="picked-again" onClick={() => void togglePicker()} title="Pick another element">
              Pick again
            </button>
            <button className="picked-close" onClick={() => setPicked(null)} title="Close">
              ×
            </button>
          </div>
          {picked.locators.map((l) => (
            <div key={l.code} className="picked-row">
              <span className="picked-kind">{l.kind}</span>
              <code title={l.code}>{l.code}</code>
              <span className={`picked-count ${l.matches === 1 ? "unique" : "multi"}`} title="Elements this locator matches on the page">
                {l.matches === 1 ? "unique" : `${l.matches} matches`}
              </span>
              <button onClick={() => copy(l.code)}>{copied === l.code ? "copied" : "copy"}</button>
            </div>
          ))}
        </div>
      )}
      {download && (
        <div className={`browser-download ${download.state}`}>
          <span>
            {download.state === "started" ? "Downloading" : download.state === "done" ? "Downloaded" : "Download failed:"} <b>{download.name || "file"}</b>
            {download.state === "done" && <small> · in Downloads</small>}
          </span>
          {download.state === "done" && download.path && (
            <button onClick={() => void invoke("browser_reveal_download", { path: download.path }).catch(() => undefined)}>Show in Finder</button>
          )}
          <button className="browser-download-x" title="Dismiss" onClick={() => setDownload(null)}>
            ×
          </button>
        </div>
      )}
      {find !== null && (
        <div className="browser-find">
          <input
            ref={findRef}
            value={find}
            placeholder="Find in page"
            spellCheck={false}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runFind(e.shiftKey);
              if (e.key === "Escape") closeFind();
            }}
          />
          <button title="Previous (⇧↵)" onClick={() => runFind(true)}>‹</button>
          <button title="Next (↵)" onClick={() => runFind(false)}>›</button>
          <button title="Close (Esc)" onClick={closeFind}>×</button>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} groups={menu.groups} onClose={() => setMenu(null)} />}
      {loading && <div className="browser-progress" />}
      {error && <div className="browser-error">{error}</div>}
      <div className="browser-slot" ref={slotRef}>
        {!isTauri && <iframe key={`${active.id}-${frameKey}`} src={active.url} title="Browser" />}
        {isTauri && !visible && <div className="browser-paused">Browser hidden while an overlay is open</div>}
      </div>
      {/* Always mounted so opening / closing can slide; polls only when open. */}
      <div className={`net-dock ${showNet ? "open" : ""} ${netDragging ? "dragging" : ""}`} style={{ height: showNet ? netHeight + 5 : 0 }}>
        <>
          <div className="net-resize" onPointerDown={startNetResize} title="Drag to resize" />
          <div className="net-wrap" style={{ height: netHeight }}>
            {isTauri ? (
              <NetworkPanel label={label} active={visible && showNet} guard={writeGuard} leak={writeGuard ? leak : null} onLeakClose={() => setLeak(null)} />
            ) : (
              <div className="net-empty">The network checker needs the desktop app.</div>
            )}
            {isTauri && (
              <button className="net-inspector" onClick={toggleDevtools} title="Full Safari Web Inspector in its own window">
                {devtoolsOpen ? "Close inspector" : "Inspector ↗"}
              </button>
            )}
          </div>
        </>
      </div>
    </div>
  );
}
