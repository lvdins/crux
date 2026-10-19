import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../net";
import { useModalKeys } from "../useModalKeys";
import { ClaudeLogo, CodexLogo, TerminalIcon } from "./icons";

export interface PastChat {
  kind: "claude" | "codex";
  id: string;
  title: string;
  prompt: string;
  at: string;
  match?: string;
}

/** Something ⌘K can jump to or do: a session, a browser tab, a place, an action. */
export interface PaletteItem {
  key: string;
  section: "Sessions" | "Browser tabs" | "Go to" | "Actions";
  icon: ReactNode;
  title: string;
  sub?: string;
  /** Right-hand hint: a shortcut, "open", a status. */
  hint?: string;
  /** Extra words it matches on. */
  keywords?: string;
  run: () => void;
}

type Row = { type: "item"; key: string; item: PaletteItem } | { type: "past"; key: string; ws: string; wsLabel: string; past: PastChat };

const SECTIONS: PaletteItem["section"][] = ["Sessions", "Browser tabs", "Go to", "Actions"];
/** Without a search, only a few of each so the list stays short. */
const IDLE_LIMIT: Record<PaletteItem["section"], number> = { Sessions: 8, "Browser tabs": 0, "Go to": 0, Actions: 4 };

const kindIcon = (k: string) => (k === "claude" ? <ClaudeLogo /> : k === "codex" ? <CodexLogo /> : <TerminalIcon />);

const when = (iso: string) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400_000);
  if (days < 1) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
};

/** Every word typed appears somewhere in the item. */
const matches = (item: PaletteItem, words: string[]) => {
  const hay = `${item.title} ${item.sub ?? ""} ${item.keywords ?? ""} ${item.section}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};

/**
 * ⌘K: find anything. Open sessions, browser tabs, workspaces and views,
 * actions ("New Codex chat in api"), and past Claude / Codex conversations
 * by what was said in them.
 */
export default function ChatSearch({
  items,
  workspaces,
  current,
  onResume,
  onClose,
}: {
  items: PaletteItem[];
  workspaces: { ws: string; label: string }[];
  /** Workspace on screen: its past chats are listed first. */
  current: string;
  onResume: (ws: string, past: PastChat) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [past, setPast] = useState<{ ws: string; chats: PastChat[] }[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);

  // Past conversations: every workspace, searched on the server (debounced).
  useEffect(() => {
    let stale = false;
    setLoading(true);
    const t = setTimeout(() => {
      Promise.all(
        workspaces.map((w) =>
          api(`/api/history/${w.ws}?q=${encodeURIComponent(q.trim())}`)
            .then((r) => (r.ok ? r.json() : { chats: [] }))
            .then((d: { chats: PastChat[] }) => ({ ws: w.ws, chats: d.chats }))
            .catch(() => ({ ws: w.ws, chats: [] as PastChat[] })),
        ),
      ).then((all) => {
        if (stale) return;
        setPast(all);
        setLoading(false);
      });
    }, q ? 250 : 0);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, workspaces]);

  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const label = (ws: string) => workspaces.find((w) => w.ws === ws)?.label ?? ws;
    const out: Row[] = [];
    for (const section of SECTIONS) {
      const hits = items.filter((i) => i.section === section && matches(i, words));
      for (const item of words.length ? hits.slice(0, 8) : hits.slice(0, IDLE_LIMIT[section])) {
        out.push({ type: "item", key: item.key, item });
      }
    }
    const pastRows: Row[] = past
      .flatMap((p) => p.chats.map((c): Row => ({ type: "past", key: `p:${p.ws}:${c.id}`, ws: p.ws, wsLabel: label(p.ws), past: c })))
      // Without a search: the open workspace's history, newest first.
      .filter((r) => words.length > 0 || (r.type === "past" && r.ws === current))
      .sort((a, b) => (a.type === "past" && b.type === "past" ? b.past.at.localeCompare(a.past.at) : 0))
      .slice(0, words.length ? 20 : 8);
    return [...out, ...pastRows];
  }, [q, items, past, workspaces, current]);
  const at = Math.min(sel, Math.max(0, rows.length - 1));

  const pick = (r: Row | undefined) => {
    if (!r) return;
    onClose();
    if (r.type === "item") r.item.run();
    else onResume(r.ws, r.past);
  };
  useModalKeys(true, { onEnter: () => pick(rows[at]), onEscape: onClose });

  // Keep the selected row in view while moving with the arrow keys.
  useEffect(() => {
    document.querySelector(".search-row.on")?.scrollIntoView({ block: "nearest" });
  }, [at]);

  let section = "";
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal search-modal" role="dialog" aria-label="Go to anything">
        <input
          className="chat-name-input search-input"
          placeholder="Sessions, browser tabs, workspaces, actions, past chats…"
          autoFocus
          spellCheck={false}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel(Math.min(at + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel(Math.max(at - 1, 0));
            }
          }}
        />
        <div className="search-list">
          {rows.length === 0 && <div className="picker-empty">{loading ? "Searching…" : "Nothing found"}</div>}
          {rows.map((r, i) => {
            const head = r.type === "item" ? r.item.section : q.trim() ? "Past conversations" : "Recent in this workspace";
            const showHead = head !== section;
            section = head;
            return (
              <div key={r.key}>
                {showHead && (
                  <div className="search-section">
                    {head}
                    {r.type === "past" && loading && <span> · searching…</span>}
                  </div>
                )}
                <button className={`search-row ${i === at ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => pick(r)}>
                  <span className="search-icons">{r.type === "item" ? r.item.icon : kindIcon(r.past.kind)}</span>
                  <span className="search-text">
                    <b>{r.type === "item" ? r.item.title : r.past.title}</b>
                    {(r.type === "past" || r.item.sub) && (
                      <span>{r.type === "item" ? r.item.sub : `${r.wsLabel} · ${r.past.match ?? r.past.prompt}`}</span>
                    )}
                  </span>
                  <span className="search-when">{r.type === "item" ? r.item.hint ?? "" : when(r.past.at)}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="search-foot">↑ ↓ to move · Enter to open · type a workspace, a site, “new codex”, “settings”…</div>
      </div>
    </div>
  );
}
