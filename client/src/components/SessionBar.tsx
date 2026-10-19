import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ClaudeLogo, CodexLogo, TerminalIcon } from "./icons";

export interface SessionTab {
  chat: string;
  name: string;
  wsLabel: string;
  /** Workspace badge colours (same as the sidebar avatar). */
  badge: CSSProperties;
  /** Main kind: the chat's agent, else shell. */
  kind: string;
  status?: "working" | "input" | "done";
  /** What the agent is doing now (from its hooks): "Bash: npm test", a question… */
  detail?: string;
  /** Workspace key: tabs are grouped by it. */
  group: string;
  /** Workspace colour, tinting its group. */
  tint?: string;
}

const kindIcon = (k: string) => (k === "claude" ? <ClaudeLogo /> : k === "codex" ? <CodexLogo /> : <TerminalIcon />);
const STATUS = { working: "Working", input: "Needs your input", done: "Finished" };

/**
 * iTerm2-style tabs above the chats: one per open session (every workspace,
 * or this one's, per Settings). Click to switch, double-click to rename,
 * drag to reorder, middle-click / × to close.
 */
export default function SessionBar({
  tabs,
  active,
  showBadges,
  onOpen,
  onClose,
  onRename,
  onMove,
  onAdd,
}: {
  tabs: SessionTab[];
  active: string;
  showBadges: boolean;
  onOpen: (chat: string) => void;
  onClose: (chat: string) => void;
  onRename: (chat: string, name: string) => void;
  onMove: (from: string, to: string) => void;
  onAdd: (e: React.MouseEvent) => void;
}) {
  const [renaming, setRenaming] = useState<{ chat: string; name: string } | null>(null);
  // One group per workspace, in the order each first appears; tabs keep their order inside.
  const groups = [...new Set(tabs.map((t) => t.group))];
  const ordered = groups.flatMap((g) => tabs.filter((t) => t.group === g));
  const drag = useRef<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  // Keep the active tab in view when there are more than fit.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(".session-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const finish = () => {
    if (renaming && renaming.name.trim()) onRename(renaming.chat, renaming.name.trim());
    setRenaming(null);
  };

  return (
    <div className="session-bar">
      <div className="session-strip" ref={strip}>
        {ordered.map((t, i) => (
          <div
            key={t.chat}
            className={`session-tab ${t.chat === active ? "on" : ""} ${i > 0 && ordered[i - 1].group !== t.group ? "group-start" : ""}`}
            style={t.tint ? ({ "--tint": t.tint } as CSSProperties) : undefined}
            title={`${t.name} · ${t.wsLabel}${t.status ? ` · ${STATUS[t.status]}` : ""}${i < 9 ? ` · ⌘${i + 1}` : ""}${t.detail ? `\n${t.detail}` : ""}\nDouble-click to rename · drag to reorder`}
            onClick={() => onOpen(t.chat)}
            onAuxClick={(e) => e.button === 1 && onClose(t.chat)}
            onDoubleClick={() => setRenaming({ chat: t.chat, name: t.name })}
            draggable={renaming?.chat !== t.chat}
            onDragStart={(e) => {
              drag.current = t.chat;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => drag.current && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (drag.current) onMove(drag.current, t.chat);
              drag.current = null;
            }}
            onDragEnd={() => (drag.current = null)}
          >
            {showBadges && (
              <span className="session-badge" style={t.badge}>
                {t.wsLabel[0]?.toUpperCase()}
              </span>
            )}
            <span className="session-kind">{kindIcon(t.kind)}</span>
            {renaming?.chat === t.chat ? (
              <input
                className="session-rename"
                value={renaming.name}
                autoFocus
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenaming({ chat: t.chat, name: e.target.value })}
                onBlur={finish}
                onKeyDown={(e) => {
                  if (e.key === "Enter") finish();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span className="session-label">
                <span className="session-name">{t.name}</span>
                {t.detail && <span className="session-detail">{t.detail}</span>}
              </span>
            )}
            {t.status === "working" ? <span className="agent-spin session-state" /> : t.status && <span className={`session-dot ${t.status}`} />}
            <button
              className="session-close"
              title="Close (⌘W)"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.chat);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="session-add" title="New session or past sessions" onClick={onAdd}>
        +
      </button>
    </div>
  );
}
