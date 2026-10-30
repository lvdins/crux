import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ClaudeLogo, CodexLogo, TerminalIcon } from "./icons";
import ContextMenu, { MenuIcons, type MenuItem } from "./ContextMenu";
import { offsetOf, rubberband, setOffset, springTo, velocityOf } from "../spring";

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
  /** Group key: its group's id, else the chat itself (a tab on its own). */
  group: string;
  /** Set when the tab is in a group: the group's name. */
  groupName?: string;
  /** Workspace colour, tinting its group. */
  tint?: string;
}

/** A split view group, shown as one tab: its chats' tabs fold into it. */
export interface SplitTab {
  id: string;
  name: string;
  /** Chats on screen in the split (their own tabs are hidden). */
  chats: string[];
  /** One letter per pane, drawn as one block. */
  badges: { letter: string; style?: CSSProperties }[];
  on: boolean;
  status?: "working" | "input" | "done";
}

const kindIcon = (k: string) => (k === "claude" ? <ClaudeLogo /> : k === "codex" ? <CodexLogo /> : <TerminalIcon />);
const STATUS = { working: "Working", input: "Needs your input", done: "Finished" };
const COLLAPSED_KEY = "crux.collapsedTabGroups";
/** Hold a dragged tab over another this long to group the two. */
const GROUP_HOLD_MS = 400;

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** The loudest status in a group: input beats working beats done. */
const groupStatus = (ts: SessionTab[]) =>
  (["input", "working", "done"] as const).find((s) => ts.some((t) => t.status === s));

/** One tab or letter on the bar, as laid out when a drag starts. */
type Slot = { el: HTMLElement; key: string; chat?: string; group?: string; left: number; width: number };

/**
 * Tabs above the chats, one per open session. Tabs stand on their own; drag
 * one onto another (hold a moment) to group the two, like browser tab groups.
 * A group shows a letter: click it to collapse the group, drag it to move the
 * group, drop a tab on it to add the tab. Dragging a tab out past the group's
 * ends takes it out. Right-click a tab or letter for the rest.
 */
export default function SessionBar({
  tabs,
  active,
  showBadges,
  onOpen,
  onClose,
  onRename,
  onPlace,
  onAssign,
  onRenameGroup,
  onDuplicate,
  onCopyPath,
  onCloseMany,
  onAdd,
  splits = [],
  onOpenSplit,
  onSplitMenu,
  onCloseSplit,
  renamingSplit,
  onRenameSplit,
  onStartRenameSplit,
}: {
  tabs: SessionTab[];
  active: string;
  showBadges: boolean;
  onOpen: (chat: string) => void;
  onClose: (chat: string) => void;
  onRename: (chat: string, name: string) => void;
  /** Move tabs next to `to` (null: the end); group: their made group, null for none, undefined to keep. */
  onPlace: (chats: string[], to: string | null, after: boolean, group?: string | null) => void;
  /** Put tabs in a made group (named when new), or null to take them out. */
  onAssign: (chats: string[], group: string | null, name?: string) => void;
  onRenameGroup: (group: string, name: string) => void;
  onDuplicate: (chat: string) => void;
  onCopyPath: (chat: string) => void;
  /** Close several tabs (asks first, per Settings); name is for the prompt. */
  onCloseMany: (chats: string[], name: string) => void;
  onAdd: (e: React.MouseEvent) => void;
  splits?: SplitTab[];
  onOpenSplit?: (id: string) => void;
  onSplitMenu?: (id: string, e: React.MouseEvent) => void;
  onCloseSplit?: (id: string) => void;
  /** The split tab being renamed; its new name, or null to keep the old. */
  renamingSplit?: string | null;
  onRenameSplit?: (id: string, name: string | null) => void;
  onStartRenameSplit?: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<{ chat: string; name: string } | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<{ group: string; name: string } | null>(null);
  // One group per workspace or made group, in the order each first appears; tabs keep their order inside.
  const groups = [...new Set(tabs.map((t) => t.group))];
  const ordered = groups.flatMap((g) => tabs.filter((t) => t.group === g));
  const membersOf = (g: string) => ordered.filter((o) => o.group === g);
  const madeNames = [...new Set(ordered.filter((o) => o.groupName).map((o) => o.groupName!))];
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleGroup = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(g)) next.add(g);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  const isTucked = (t: SessionTab) => !!t.groupName && collapsed.has(t.group) && t.chat !== active;
  const strip = useRef<HTMLDivElement>(null);
  const swallowClick = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; groups: MenuItem[][] } | null>(null);

  // A new group: named "Group N", its name open for editing (as Chrome does).
  const newGroup = (chats: string[]) => {
    const id = `g${Date.now().toString(36)}`;
    let n = 1;
    while (madeNames.includes(`Group ${n}`)) n++;
    onAssign(chats, id, `Group ${n}`);
    setRenamingGroup({ group: id, name: `Group ${n}` });
    return id;
  };

  // ---- dragging (pointer events: HTML5 drag-and-drop is unreliable in the WebView) ----
  const [dragging, setDragging] = useState<{ chat?: string; group?: string } | null>(null);
  // The tab or letter a dragged tab would group with ("g:<id>" for a letter).
  const [into, setInto] = useState<string | null>(null);

  /**
   * Drag a tab (or a group by its letter): it follows the pointer and the
   * others slide aside to open a gap where it will land. Rest a tab over the
   * middle of another for a moment to group the two; drop it on a letter to
   * add it to that group. Where the gap is decides the group: between two
   * tabs of a group, in it; anywhere else, on its own.
   */
  const startDrag = (what: { chat?: string; group?: string }) => (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,input")) return;
    e.preventDefault(); // no text selection while dragging (click still fires)
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    // Laid out once, when the drag starts; everything after is transforms.
    let all: Slot[] = [];
    let dragged: Slot[] = [];
    let rest: Slot[] = [];
    let first = 0; // index in `all` of the dragged block
    let last = 0;
    let w = 0; // how far the others move to open the gap
    let gap = 0; // index in `rest` the dragged block would land at
    let target: string | null = null; // into-key, as `into`
    let hold: ReturnType<typeof setTimeout> | undefined;
    let holding: string | null = null;
    let base = new Map<HTMLElement, number>(); // where each dragged piece was when grabbed (mid-glide)
    let lo = -Infinity; // how far the block can go before the bar edge resists
    let hi = Infinity;
    const shifts = new Map<HTMLElement, number>();
    const trail: { t: number; x: number }[] = []; // recent pointer positions, for release speed

    const measure = () => {
      const keys = new Set(what.chat ? [what.chat] : [`g:${what.group}`, ...membersOf(what.group!).map((o) => o.chat)]);
      all = [...strip.current!.children]
        .map((el) => el as HTMLElement)
        .filter((el) => el.dataset.chat || el.dataset.group)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const key = el.dataset.chat ?? `g:${el.dataset.group}`;
          // Layout position, without whatever glide it's still in.
          return { el, key, chat: el.dataset.chat, group: el.dataset.group, left: r.left - offsetOf(el), width: r.width };
        });
      dragged = all.filter((o) => keys.has(o.key));
      rest = all.filter((o) => !keys.has(o.key));
      first = all.indexOf(dragged[0]);
      last = all.indexOf(dragged.at(-1)!);
      const next = all[last + 1];
      const end = dragged.at(-1)!.left + dragged.at(-1)!.width;
      w = end - dragged[0].left + (next ? Math.max(0, next.left - end) : 3);
      gap = first;
      base = new Map(dragged.map((o) => [o.el, offsetOf(o.el)]));
      for (const o of rest) shifts.set(o.el, offsetOf(o.el));
      for (const o of dragged) o.el.style.pointerEvents = "none";
      const bar = strip.current!.getBoundingClientRect();
      lo = bar.left - dragged[0].left;
      hi = bar.right - end;
    };
    // Where a slot of `rest` sits with the gap at `g`.
    const shiftOf = (o: Slot, j: number, g: number) => {
      const f = all.indexOf(o);
      return f > last && j < g ? -w : f < first && j >= g ? w : 0;
    };
    const paint = (dx: number) => {
      // The others spring aside; re-targeting mid-way keeps their speed.
      rest.forEach((o, j) => {
        const sh = shiftOf(o, j, gap);
        if (shifts.get(o.el) === sh) return;
        shifts.set(o.el, sh);
        springTo(o.el, sh, { response: 0.26 });
      });
      // The dragged block follows the pointer 1:1, resisting past the bar's ends.
      for (const o of dragged) {
        const at = base.get(o.el)! + dx;
        const x = at < lo ? lo + rubberband(at - lo, 120) : at > hi ? hi + rubberband(at - hi, 120) : at;
        setOffset(o.el, x);
      }
    };
    const speed = () => {
      const now = performance.now();
      const recent = trail.filter((p) => now - p.t < 100);
      if (recent.length < 2) return 0;
      const a = recent[0];
      const b = recent.at(-1)!;
      return b.t > a.t ? ((b.x - a.x) / (b.t - a.t)) * 1000 : 0;
    };
    const setTarget = (t: string | null) => {
      if (t === target) return;
      target = t;
      setInto(t);
    };

    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      if (!moved) {
        moved = true;
        window.getSelection()?.removeAllRanges();
        setDragging(what);
        measure();
      }
      const x = ev.clientX;
      trail.push({ t: performance.now(), x });
      if (trail.length > 8) trail.shift();
      const bar = strip.current!.getBoundingClientRect();
      if (ev.clientY < bar.top - 40 || ev.clientY > bar.bottom + 40) {
        // Far off the bar: nothing happens on drop.
        gap = first;
        clearTimeout(hold);
        holding = null;
        setTarget(null);
        return paint(x - startX);
      }
      // What's under the pointer now (with the others where they slid to).
      const j = rest.findIndex((o, k) => {
        const l = o.left + shiftOf(o, k, gap);
        return o.width > 0 && x >= l && x <= l + o.width;
      });
      let candidate: string | null = null;
      if (j < 0) {
        const lastRest = rest.at(-1);
        const firstRest = rest[0];
        if (lastRest && x > lastRest.left + shiftOf(lastRest, rest.length - 1, gap) + lastRest.width) gap = rest.length;
        else if (firstRest && x < firstRest.left + shiftOf(firstRest, 0, gap)) gap = 0; // past the front of the bar
      } else {
        const o = rest[j];
        const rel = (x - (o.left + shiftOf(o, j, gap))) / o.width;
        if (o.group) {
          // A letter: its front edge places a tab before the group (on its
          // own); the rest of it joins the group. A group moves by halves.
          if (what.chat) {
            if (rel < 0.45) gap = j;
            else candidate = o.key;
          } else gap = rel < 0.5 ? j : j + 1;
        } else if (j < gap) {
          // Left of the gap: past its middle the gap jumps before it; resting
          // on the near half (a tab) groups with it.
          if (rel < 0.5) gap = j;
          else if (j < gap - 1) gap = j + 1;
          else if (what.chat && rel < 0.8) candidate = o.key;
        } else {
          if (rel > 0.5) gap = j + 1;
          else if (j > gap) gap = j;
          else if (what.chat && rel > 0.2) candidate = o.key;
        }
      }
      // A group never lands inside another group.
      if (what.group) {
        const prev = rest[gap - 1];
        const next = rest[gap];
        const inside = (o?: Slot) => (o?.chat ? ordered.find((t) => t.chat === o.chat)?.groupName && ordered.find((t) => t.chat === o.chat)!.group : o?.group);
        const g = inside(next);
        if (g && next?.chat && inside(prev) === g) gap = rest.findIndex((o) => o.group === g);
      }
      // Letters join at once; tabs after a short rest.
      if (candidate?.startsWith("g:")) {
        clearTimeout(hold);
        holding = null;
        setTarget(candidate);
      } else if (candidate !== holding) {
        clearTimeout(hold);
        holding = candidate;
        setTarget(null);
        if (candidate) hold = setTimeout(() => setTarget(candidate), GROUP_HOLD_MS);
      }
      paint(x - startX);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      clearTimeout(hold);
      setDragging(null);
      setInto(null);
      if (!moved) return;
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 0);
      const v = speed();
      const nothing = !target && gap === first;
      if (nothing) {
        // Dropped where it was: everything springs back, the dragged block
        // carrying the pointer's speed.
        for (const o of all) {
          o.el.style.pointerEvents = "";
          springTo(o.el, 0, dragged.includes(o) ? { velocity: v, damping: 0.85, response: 0.34 } : {});
        }
        return;
      }
      // Moving: note where everything is on screen now; once the bar re-renders
      // in the new order, each tab springs from here to its place (settle()).
      flip.current = new Map(all.map((o) => [o.key, { left: o.el.getBoundingClientRect().left, v: dragged.includes(o) ? v : velocityOf(o.el), thrown: dragged.includes(o) }]));
      setTimeout(settle, 300); // in case nothing re-renders

      const chats = dragged.filter((o) => o.chat).map((o) => o.chat!);
      if (target) {
        // Grouping: with a tab, or into a letter's group.
        if (target.startsWith("g:")) {
          const g = target.slice(2);
          return onPlace(chats, membersOf(g).at(-1)!.chat, true, g);
        }
        const t = ordered.find((o) => o.chat === target)!;
        onPlace(chats, t.chat, true, t.groupName ? t.group : null);
        if (!t.groupName) newGroup([t.chat, ...chats]);
        return;
      }
      if (gap === first) return;
      const prev = rest[gap - 1];
      const next = rest[gap];
      if (what.group) {
        if (next) onPlace(chats, next.chat ?? membersOf(next.group!)[0].chat, false);
        else onPlace(chats, null, true);
        return;
      }
      // In a group only when landing between two of its tabs (its letter counts as the start).
      const groupOf = (o?: Slot) => (o?.group ? o.group : o?.chat ? ordered.find((t) => t.chat === o.chat)?.groupName && ordered.find((t) => t.chat === o.chat)!.group : undefined);
      const g = groupOf(next) && groupOf(next) === groupOf(prev) ? groupOf(next) || null : null;
      if (next?.chat) onPlace(chats, next.chat, false, g);
      else if (next?.group) onPlace(chats, membersOf(next.group)[0].chat, false, null);
      else onPlace(chats, null, true, null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // After a drop: clear the drag's transforms and slide each tab from where it
  // was on screen to its new place, before the first paint of the new order.
  const flip = useRef<Map<string, { left: number; v: number; thrown: boolean }> | null>(null);
  const settle = () => {
    const before = flip.current;
    const bar = strip.current;
    if (!before || !bar) return;
    flip.current = null;
    const els = [...bar.children].map((el) => el as HTMLElement).filter((el) => el.dataset.chat || el.dataset.group);
    for (const el of els) {
      setOffset(el, 0);
      el.style.pointerEvents = "";
    }
    for (const el of els) {
      const old = before.get(el.dataset.chat ?? `g:${el.dataset.group}`);
      if (!old) continue;
      const dx = old.left - el.getBoundingClientRect().left;
      // A thrown tab lands with a touch of bounce; the rest settle flat.
      springTo(el, 0, { from: dx, velocity: old.v, ...(old.thrown ? { damping: 0.85, response: 0.34 } : {}) });
    }
  };
  useLayoutEffect(settle);

  // ---- right-click menus ----
  const tabMenu = (e: React.MouseEvent, t: SessionTab) => {
    e.preventDefault();
    const at = ordered.indexOf(t);
    const others = ordered.filter((o) => o.chat !== t.chat).map((o) => o.chat);
    const right = ordered.slice(at + 1).map((o) => o.chat);
    const otherGroups = [...new Set(ordered.filter((o) => o.groupName && o.group !== t.group).map((o) => o.group))].slice(0, 5);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      groups: [
        [
          { label: "Rename", icon: MenuIcons.rename, onSelect: () => setRenaming({ chat: t.chat, name: t.name }) },
          { label: "Duplicate", icon: MenuIcons.copy, onSelect: () => onDuplicate(t.chat) },
          { label: "Copy workspace path", icon: MenuIcons.copy, onSelect: () => onCopyPath(t.chat) },
        ],
        [
          ...(t.groupName ? [{ label: "Remove from group", icon: MenuIcons.remove, onSelect: () => onPlace([t.chat], membersOf(t.group).at(-1)!.chat, true, null) }] : []),
          ...(!t.groupName && ordered[at + 1] && !ordered[at + 1].groupName
            ? [{ label: "Group with next tab", icon: MenuIcons.folder, onSelect: () => newGroup([t.chat, ordered[at + 1].chat]) }]
            : []),
          ...otherGroups.map((g) => {
            const first = membersOf(g)[0];
            return { label: `Add to “${first.groupName}”`, icon: MenuIcons.folder, onSelect: () => onPlace([t.chat], membersOf(g).at(-1)!.chat, true, g) };
          }),
        ],
        [
          { label: "Close tab", icon: MenuIcons.remove, shortcut: "⌘W", onSelect: () => onClose(t.chat) },
          ...(right.length ? [{ label: "Close tabs to the right", icon: MenuIcons.trash, danger: true, onSelect: () => onCloseMany(right, `${right.length} tabs`) }] : []),
          ...(others.length ? [{ label: "Close other tabs", icon: MenuIcons.trash, danger: true, onSelect: () => onCloseMany(others, `${others.length} other tabs`) }] : []),
        ],
      ],
    });
  };

  const groupMenu = (e: React.MouseEvent, t: SessionTab) => {
    e.preventDefault();
    const members = membersOf(t.group).map((o) => o.chat);
    const label = t.groupName ?? "";
    setMenu({
      x: e.clientX,
      y: e.clientY,
      groups: [
        [
          { label: "Rename group", icon: MenuIcons.rename, onSelect: () => setRenamingGroup({ group: t.group, name: label }) },
          { label: collapsed.has(t.group) ? "Expand group" : "Collapse group", icon: MenuIcons.folder, onSelect: () => toggleGroup(t.group) },
          { label: "Ungroup", icon: MenuIcons.remove, onSelect: () => onAssign(members, null) },
        ],
        [{ label: "Close group", icon: MenuIcons.trash, danger: true, onSelect: () => onCloseMany(members, `“${label}” (${members.length} tabs)`) }],
      ],
    });
  };

  // Keep the active tab in view when there are more than fit.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(".session-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const finish = () => {
    if (renaming && renaming.name.trim()) onRename(renaming.chat, renaming.name.trim());
    setRenaming(null);
  };
  const finishGroup = () => {
    if (renamingGroup && renamingGroup.name.trim()) onRenameGroup(renamingGroup.group, renamingGroup.name.trim());
    setRenamingGroup(null);
  };
  // Split groups: drawn where their first chat's tab would be; ones with no
  // chat (Ops + Browser…) after the tabs.
  const splitOf = new Map(splits.flatMap((s) => s.chats.map((c) => [c, s] as const)));
  const drawnSplits = new Set<string>();
  const splitTab = (s: SplitTab) => (
    <div
      key={`s:${s.id}`}
      role="button"
      className={`session-tab split-tab ${s.on ? "on" : ""}`}
      title={`${s.name}${s.status ? ` · ${STATUS[s.status]}` : ""}\nSplit view · right-click for more`}
      onClick={() => onOpenSplit?.(s.id)}
      onDoubleClick={() => onStartRenameSplit?.(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onSplitMenu?.(s.id, e);
      }}
    >
      {showBadges && (
        <span className="session-badges">
          {s.badges.map((b, i) => (
            <span key={i} className="session-badge" style={b.style}>
              {b.letter}
            </span>
          ))}
        </span>
      )}
      {renamingSplit === s.id ? (
        <input
          className="session-rename"
          defaultValue={s.name}
          autoFocus
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          // Unchanged keeps the name made from its views (it follows them).
          onBlur={(e) => onRenameSplit?.(s.id, e.currentTarget.value.trim() === s.name ? null : e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = s.name;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <span className="session-label">
          <span className="session-name">{s.name}</span>
        </span>
      )}
      {s.status === "working" ? <span className="agent-spin session-state" /> : s.status && <span className={`session-dot ${s.status}`} />}
      <button
        className="session-close"
        title="Ungroup this split"
        onClick={(e) => {
          e.stopPropagation();
          onCloseSplit?.(s.id);
        }}
      >
        ×
      </button>
    </div>
  );
  const markFor = (key: string) => (into === key ? "drop-into" : "");
  const lifted = (t: SessionTab) => dragging?.chat === t.chat || dragging?.group === t.group;

  return (
    <div className={`session-bar ${dragging ? "dragging" : ""}`}>
      <div className="session-strip" ref={strip}>
        {ordered.map((t, i) => {
          const inSplit = splitOf.get(t.chat);
          if (inSplit) {
            if (drawnSplits.has(inSplit.id)) return null;
            drawnSplits.add(inSplit.id);
            return splitTab(inSplit);
          }
          const first = i === 0 || ordered[i - 1].group !== t.group;
          const shut = !!t.groupName && collapsed.has(t.group);
          // A made group takes its first tab's colour for every tab in it.
          const tint = t.groupName ? membersOf(t.group)[0].tint : t.tint;
          const tintStyle = tint ? ({ "--tint": tint } as CSSProperties) : undefined;
          const members = first && t.groupName ? membersOf(t.group) : [];
          const st = members.length ? groupStatus(members) : undefined;
          const label = t.groupName ?? "";
          const chip = members.length > 0 && (
            <div
              key={`g:${t.group}`}
              data-group={t.group}
              role="button"
              className={`session-group ${shut ? "shut" : ""} ${i > 0 ? "group-start" : ""} ${lifted(t) ? "lifted" : ""} ${markFor(`g:${t.group}`)}`}
              style={tintStyle}
              title={`${label} · ${members.length} tab${members.length === 1 ? "" : "s"}${st ? ` · ${STATUS[st]}` : ""}\nClick to ${shut ? "expand" : "collapse"} · drag to move · right-click for more`}
              onPointerDown={renamingGroup?.group === t.group ? undefined : startDrag({ group: t.group })}
              onClick={() => !swallowClick.current && toggleGroup(t.group)}
              onDoubleClick={() => setRenamingGroup({ group: t.group, name: label })}
              onContextMenu={(e) => groupMenu(e, t)}
            >
              {renamingGroup?.group === t.group ? (
                <input
                  className="session-rename"
                  value={renamingGroup.name}
                  autoFocus
                  spellCheck={false}
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenamingGroup({ group: t.group, name: e.target.value })}
                  onBlur={finishGroup}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") finishGroup();
                    if (e.key === "Escape") setRenamingGroup(null);
                  }}
                />
              ) : (
                <span className="session-group-letter">
                  {label[0]?.toUpperCase()}
                </span>
              )}
              {shut && st && <span className={`session-group-status ${st}`} />}
            </div>
          );
          // Collapsed tabs stay mounted so they can slide in and out.
          const tucked = isTucked(t);
          return [
            chip,
            <div
              key={t.chat}
              data-chat={t.chat}
              className={`session-tab ${t.chat === active ? "on" : ""} ${t.groupName ? "in-group" : ""} ${t.groupName && (i === ordered.length - 1 || ordered[i + 1].group !== t.group) ? "group-end" : ""} ${lifted(t) ? "lifted" : ""} ${tucked ? "tucked" : ""} ${markFor(t.chat)}`}
              aria-hidden={tucked || undefined}
              style={tintStyle}
              title={`${t.name} · ${t.wsLabel}${t.status ? ` · ${STATUS[t.status]}` : ""}${i < 9 ? ` · ⌘${i + 1}` : ""}${t.detail ? `\n${t.detail}` : ""}\nDrag to move · hold over a tab to group · right-click for more`}
              onPointerDown={renaming?.chat === t.chat ? undefined : startDrag({ chat: t.chat })}
              onClick={() => !swallowClick.current && onOpen(t.chat)}
              onAuxClick={(e) => e.button === 1 && onClose(t.chat)}
              onContextMenu={(e) => tabMenu(e, t)}
              onDoubleClick={() => setRenaming({ chat: t.chat, name: t.name })}
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
            </div>,
          ];
        })}
        {splits.filter((s) => !s.chats.some((c) => ordered.some((t) => t.chat === c))).map(splitTab)}
      </div>
      <button className="session-add" title="New session or past sessions" onClick={onAdd}>
        +
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} groups={menu.groups} onClose={() => setMenu(null)} />}
    </div>
  );
}
