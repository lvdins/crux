import { useMemo, useState } from "react";
import { ClaudeLogo, CodexLogo, TerminalIcon } from "./icons";
import { useModalKeys } from "../useModalKeys";

type Target = { chat: string } | { newIn: string };

interface Group {
  ws: string;
  label: string;
  chats: { chat: string; name: string; kinds: string[] }[];
}

/** An open agent chat, listed first ("Active chats"), in the menu bar's order. */
export interface ActiveChat {
  chat: string;
  name: string;
  wsLabel: string;
  kinds: string[];
  workingSince?: number;
  waiting?: "input" | "stop";
}

const ACTIVE = "Active chats";
const stateOf = (a: ActiveChat) => (a.waiting === "input" ? "Needs input" : a.waiting === "stop" ? "Finished" : a.workingSince ? "Working" : "");

const kindIcon = (k: string) => (k === "claude" ? <ClaudeLogo /> : k === "codex" ? <CodexLogo /> : <TerminalIcon />);

/** Where should this image go? Open agent chats first, then every workspace's chats plus a new Claude chat. */
export default function ChatPicker({
  preview,
  active = [],
  groups,
  onPick,
  onCancel,
}: {
  preview: string;
  active?: ActiveChat[];
  groups: Group[];
  onPick: (to: Target) => void;
  onCancel: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState(0);

  // Flat list of choices (what ↑ ↓ move through), filtered by the search.
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const out: { to: Target; ws: string; label: string; kinds?: string[]; isNew?: boolean; sub?: string; state?: string }[] = [];
    for (const a of active) {
      if (f && !a.name.toLowerCase().includes(f) && !a.wsLabel.toLowerCase().includes(f)) continue;
      out.push({ to: { chat: a.chat }, ws: ACTIVE, label: a.name, kinds: a.kinds, sub: a.wsLabel, state: stateOf(a) });
    }
    for (const g of groups) {
      const wsHit = g.label.toLowerCase().includes(f);
      for (const c of g.chats) {
        if (!f || wsHit || c.name.toLowerCase().includes(f)) out.push({ to: { chat: c.chat }, ws: g.label, label: c.name, kinds: c.kinds });
      }
      if (!f || wsHit) out.push({ to: { newIn: g.ws }, ws: g.label, label: "New Claude chat", isNew: true });
    }
    return out;
  }, [groups, filter]);
  const at = Math.min(sel, Math.max(0, rows.length - 1));

  useModalKeys(true, { onEnter: () => rows[at] && onPick(rows[at].to), onEscape: onCancel });

  let lastWs = "";
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal picker-modal" role="dialog" aria-label="Add the image to a chat">
        <div className="picker-head">
          <img src={preview} alt="Marked area" />
          <div>
            <b>Add to which chat?</b>
            <span>The image goes into the agent's input; nothing is sent.</span>
          </div>
        </div>
        <input
          className="chat-name-input"
          placeholder="Search workspaces and chats"
          autoFocus
          spellCheck={false}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
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
        <div className="picker-list">
          {rows.length === 0 && <div className="picker-empty">No matching workspace or chat</div>}
          {rows.map((row, i) => {
            const head = row.ws !== lastWs ? <div className="picker-ws">{row.ws}</div> : null;
            lastWs = row.ws;
            return (
              <div key={i}>
                {head}
                <button
                  className={`picker-row ${i === at ? "on" : ""} ${row.isNew ? "new" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => onPick(row.to)}
                >
                  <span className="picker-icons">{row.isNew ? "+" : row.kinds!.slice(0, 3).map((k) => <span key={k}>{kindIcon(k)}</span>)}</span>
                  <span className="picker-label">{row.label}</span>
                  {row.sub && <span className="picker-sub">{row.sub}</span>}
                  {row.state && <span className={`picker-state ${row.state === "Needs input" ? "input" : row.state === "Working" ? "working" : ""}`}>{row.state}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
