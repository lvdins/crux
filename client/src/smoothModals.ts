import { springEasing } from "./spring";

/**
 * Every dialog (.modal) eases to its new height when its content grows or
 * shrinks (search results, an error line, a folder listing), instead of
 * jumping. The dialog's own layout is untouched: only its height is animated,
 * from the old size to the new one, right before the frame is painted.
 *
 * Settings has its own (SmoothHeight around the page), so it's skipped here.
 */
const watched = new WeakSet<HTMLElement>();

function watch(modal: HTMLElement) {
  if (watched.has(modal) || modal.classList.contains("settings-modal")) return;
  watched.add(modal);
  let last = -1;
  let anim: Animation | null = null;
  const run = (from: number, to: number) => {
    const frames = [{ height: `${from}px`, overflow: "hidden" }, { height: `${to}px`, overflow: "hidden" }];
    try {
      anim = modal.animate(frames, { duration: 440, easing: springEasing() });
    } catch {
      anim = modal.animate(frames, { duration: 320, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
    }
    anim.onfinish = () => {
      anim = null;
      // Changed again while it was moving: carry on from here to the new size.
      const now = modal.getBoundingClientRect().height;
      if (Math.abs(now - to) >= 1 && modal.isConnected) {
        last = now;
        run(to, now);
      }
    };
  };
  // Runs after layout, before paint: the jump is never seen.
  const ro = new ResizeObserver(() => {
    if (!modal.isConnected) return ro.disconnect();
    if (anim) return; // our own frames; re-checked when it finishes
    const h = modal.getBoundingClientRect().height;
    if (last < 0 || Math.abs(h - last) < 1) return void (last = h);
    const from = last;
    last = h;
    if (document.documentElement.hasAttribute("data-reduce-motion")) return;
    if (modal.closest(".closing")) return;
    run(from, h);
  });
  ro.observe(modal);
}

export function installSmoothModals() {
  const scan = (root: ParentNode) => root.querySelectorAll<HTMLElement>(".modal").forEach(watch);
  new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.classList.contains("modal")) watch(n);
        scan(n);
      }
  }).observe(document.body, { childList: true, subtree: true });
  scan(document);
}
