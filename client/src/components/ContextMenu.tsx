import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  shortcut?: string;
}

/** Items separated into groups; a divider is drawn between groups. */
export default function ContextMenu({
  x,
  y,
  groups,
  top,
  onClose,
}: {
  x: number;
  y: number;
  groups: MenuItem[][];
  /** Custom content above the items (e.g. colour swatches). */
  top?: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu on screen: flip up/left when it would overflow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width > window.innerWidth - 8 ? Math.max(8, x - width) : x;
    const top = y + height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - height - 8) : y;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu" ref={ref} style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {top && <div className="ctx-group ctx-top">{top}</div>}
      {groups.map((group, gi) => (
        <div key={gi} className="ctx-group">
          {group.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`ctx-item ${item.danger ? "danger" : ""}`}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <span className="ctx-icon">{item.icon}</span>
              <span className="ctx-label">{item.label}</span>
              {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

const svg = (d: ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

export const MenuIcons = {
  pin: svg(<path d="M5.5 2h5M6.5 2v4L4 9h8L9.5 6V2M8 9v5" />),
  unpin: svg(<><path d="M5.5 2h5M6.5 2v4L4 9h8L9.5 6V2M8 9v5" /><path d="M2.5 2.5l11 11" /></>),
  rename: svg(<path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5z" />),
  folder: svg(<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5H13c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />),
  copy: svg(<><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.8c0-.7-.5-1.3-1.2-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.5c0 .7.6 1.2 1.3 1.2h1.7" /></>),
  branch: svg(<><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" /><path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" /></>),
  unread: svg(<><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /><path d="M2.5 13.5l11-11" /></>),
  read: svg(<><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>),
  remove: svg(<path d="M4 4l8 8M12 4l-8 8" />),
  trash: svg(<path d="M2.5 4h11M6 4V2.8h4V4M3.8 4l.7 9.2c0 .5.5.8 1 .8h5c.5 0 1-.3 1-.8l.7-9.2M6.7 6.5v5M9.3 6.5v5" />),
};
