import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../net";
import type { PastChat } from "./ChatSearch";
import { ClaudeLogo, CodexLogo } from "./icons";

type Past = PastChat & { ws: string; branch?: string };

const GROUPS = ["Today", "Yesterday", "This week", "Older"] as const;
function groupOf(iso: string): (typeof GROUPS)[number] {
  const d = new Date(iso);
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  if (d >= day) return "Today";
  if (d >= new Date(day.getTime() - 86_400_000)) return "Yesterday";
  if (d >= new Date(day.getTime() - 6 * 86_400_000)) return "This week";
  return "Older";
}
const when = (iso: string) => {
  const d = new Date(iso);
  return groupOf(iso) === "Today" || groupOf(iso) === "Yesterday"
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
};

/**
 * Sidebar → Sessions: past Claude and Codex chats from every workspace,
 * newest first. Click one to resume it in a new tab (or show it if open).
 */
export default function SessionsPanel({
  workspaces,
  isOpen,
  onResume,
}: {
  workspaces: Record<string, { label: string; badge: CSSProperties }>;
  /** A past chat that is open in a tab right now. */
  isOpen: (id: string) => boolean;
  onResume: (ws: string, past: PastChat) => void;
}) {
  const [q, setQ] = useState("");
  const [chats, setChats] = useState<Past[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(
      () =>
        void api(`/api/history${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`)
          .then((r) => r.json())
          .then((body) => !cancelled && setChats(Array.isArray(body.chats) ? body.chats : []))
          .catch(() => !cancelled && setChats([])),
      q ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const known = (chats ?? []).filter((c) => workspaces[c.ws]);
  return (
    <section className="full-pane sessions-pane">
      <div className="sessions-head">
        <h2>Sessions</h2>
        <input className="sessions-filter" placeholder="Search past sessions" value={q} autoFocus spellCheck={false} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="sessions-list">
        {chats === null ? (
          <p className="home-empty">Reading past sessions…</p>
        ) : !known.length ? (
          <p className="home-empty">{q ? "No sessions match." : "No past Claude or Codex sessions yet."}</p>
        ) : (
          GROUPS.map((g) => {
            const rows = known.filter((c) => groupOf(c.at) === g);
            if (!rows.length) return null;
            return (
              <div key={g} className="sessions-group">
                <h3>{g}</h3>
                {rows.map((c) => {
                  const ws = workspaces[c.ws];
                  const open = isOpen(c.id);
                  return (
                    <button key={`${c.ws}:${c.id}`} className="sessions-row" onClick={() => onResume(c.ws, c)} title={c.prompt}>
                      <span className="sessions-kind">{c.kind === "claude" ? <ClaudeLogo /> : <CodexLogo />}</span>
                      <span className="sessions-text">
                        <b>{c.title || c.prompt.slice(0, 60)}</b>
                        <span>
                          <span className="session-badge" style={ws.badge}>
                            {ws.label[0]?.toUpperCase()}
                          </span>
                          {ws.label}
                          {c.branch && <code>{c.branch}</code>}
                          {c.match && <em>{c.match}</em>}
                        </span>
                      </span>
                      {open && <span className="sessions-open">open</span>}
                      <span className="sessions-when">{when(c.at)}</span>
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
