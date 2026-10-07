import { useEffect, useRef } from "react";

interface Keys {
  onEnter?: () => void;
  onEscape?: () => void;
}

// Open dialogs, newest last: only the top one answers Enter / Esc, so a
// dialog opened over another (Add workspace over the setup guide) wins.
const stack: { current: Keys }[] = [];

window.addEventListener(
  "keydown",
  (e) => {
    const top = stack[stack.length - 1]?.current;
    if (!top || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const run = e.key === "Enter" && !e.shiftKey ? top.onEnter : e.key === "Escape" ? top.onEscape : undefined;
    if (!run) return;
    // Stop the focused button / terminal from also acting on the key.
    e.preventDefault();
    e.stopPropagation();
    run();
  },
  true,
);

/** Enter confirms and Esc cancels while `active` (a dialog is open). */
export function useModalKeys(active: boolean, keys: Keys): void {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!active) return;
    const entry = ref;
    stack.push(entry);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
