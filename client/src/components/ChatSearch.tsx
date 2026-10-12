import { useEffect, useMemo, useState } from "react";
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

interface OpenChat {
  chat: string;
  ws: string;
  wsLabel: string;
  name: string;
  kinds: string[];
}

type Row =
  | { type: "open"; key: string; chat: OpenChat }
  | { type: "past"; key: string; ws: string; wsLabel: string; past: PastChat };

const kindIcon = (k: string) => (k === "claude" ? <ClaudeLogo /> : k === "codex" ? <CodexLogo /> : <TerminalIcon />);

const when = (iso: string) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400_000);
  if (days < 1) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
};

/** ⌘K: find an open chat by name, or a past Claude / Codex conversation by what was said. */
export default function ChatSearch({
  open,
  workspaces,
  current,
  onOpen,
  onResume,
  onClose,
}: {
  open: OpenChat[];
  workspaces: { ws: string; label: string }[];
  /** Workspace on screen: its past chats are listed first. */
  current: string;
  onOpen: (chat: string) => void;
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
    const f = q.trim().toLowerCase();
    const label = (ws: string) => workspaces.find((w) => w.ws === ws)?.label ?? ws;
    const out: Row[] = open
      .filter((c) => !f || c.name.toLowerCase().includes(f) || c.wsLabel.toLowerCase().includes(f))
      .map((c) => ({ type: "open", key: `o:${c.chat}`, chat: c }));
    const pastRows: Row[] = past
      .flatMap((p) => p.chats.map((c): Row => ({ type: "past", key: `p:${c.id}`, ws: p.ws, wsLabel: label(p.ws), past: c })))
      // Without a search: the open workspace's history, newest first.
      .filter((r) => f || (r.type === "past" && r.ws === current))
      .sort((a, b) => (a.type === "past" && b.type === "past" ? b.past.at.localeCompare(a.past.at) : 0))
      .slice(0, 30);
    return [...out, ...pastRows];
  }, [q, open, past, workspaces, current]);
  const at = Math.min(sel, Math.max(0, rows.length - 1));

  const pick = (r: Row | undefined) => {
    if (!r) return;
    if (r.type === "open") onOpen(r.chat.chat);
    else onResume(r.ws, r.past);
  };
  useModalKeys(true, { onEnter: () => pick(rows[at]), onEscape: onClose });

  let section = "";
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal search-modal" role="dialog" aria-label="Search chats">
        <input
          className="chat-name-input search-input"
          placeholder="Search chats and past conversations…"
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
            const head = r.type === "open" ? "Open chats" : q.trim() ? "Past conversations" : "Recent in this workspace";
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
                <button
                  className={`search-row ${i === at ? "on" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => pick(r)}
                >
                  <span className="search-icons">
                    {r.type === "open" ? r.chat.kinds.slice(0, 2).map((k) => <span key={k}>{kindIcon(k)}</span>) : kindIcon(r.past.kind)}
                  </span>
                  <span className="search-text">
                    <b>{r.type === "open" ? r.chat.name : r.past.title}</b>
                    <span>
                      {r.type === "open" ? r.chat.wsLabel : `${r.wsLabel} · ${r.past.match ?? r.past.prompt}`}
                    </span>
                  </span>
                  <span className="search-when">{r.type === "open" ? "open" : when(r.past.at)}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="search-foot">↑ ↓ to move · Enter to open · past conversations reopen where they left off</div>
      </div>
    </div>
  );
}
