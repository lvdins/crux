/**
 * Mac vs Linux / Windows. On macOS Crux's shortcuts use ⌘; elsewhere they use
 * Ctrl+Shift, because plain Ctrl+S / Ctrl+B / Ctrl+K already mean something
 * in a terminal (and terminal apps there use Ctrl+Shift the same way).
 */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** An app shortcut: ⌘<key> on macOS, Ctrl+Shift+<key> elsewhere. */
export function isAppShortcut(e: KeyboardEvent, key: string): boolean {
  if (e.altKey || e.key.toLowerCase() !== key) return false;
  return IS_MAC ? (e.metaKey || e.ctrlKey) && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey;
}

/** How a shortcut reads on this machine, e.g. KEY.search → "⌘K" or "Ctrl+Shift+K". */
export const KEY = IS_MAC
  ? { sidebar: "⌘S", panel: "⌘B", search: "⌘K", mark: "⌘⇧C", deleteWs: "⌘⇧⌫", quickAsk: "⌥Space", askOpen: "⌘Enter", quickSearch: "⌘K" }
  : {
      sidebar: "Ctrl+Shift+S",
      panel: "Ctrl+Shift+B",
      search: "Ctrl+Shift+K",
      mark: "Ctrl+Shift+C",
      deleteWs: "Ctrl+Shift+Backspace",
      quickAsk: "Ctrl+Alt+Space",
      askOpen: "Ctrl+Enter",
      // Quick ask is its own window (no terminal there): plain Ctrl+K.
      quickSearch: "Ctrl+K",
    };
