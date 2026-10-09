import { useMemo, useState } from "react";
import { ClaudeLogo, CodexLogo, TerminalIcon } from "./icons";
import { useModalKeys } from "../useModalKeys";

type Target = { chat: string } | { newIn: string };

interface Group {
  ws: string;
  label: string;
  chats: { chat: string; name: string; kinds: string[] }[];
}

const kindIcon = (k: string) => (k === "claude" ? <ClaudeLogo /> : k === "codex" ? <CodexLogo /> : <TerminalIcon />);

/** Where should this image go? Every workspace's chats, plus a new Claude chat. */
export default function ChatPicker({
  preview,
  groups,
  onPick,
  onCancel,
}: {
  preview: string;
  groups: Group[];
  onPick: (to: Target) => void;
  onCancel: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState(0);

  // Flat list of choices (what ↑ ↓ move through), filtered by the search.
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const out: { to: Target; ws: string; label: string; kinds?: string[]; isNew?: boolean }[] = [];
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
                  {row.label}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
