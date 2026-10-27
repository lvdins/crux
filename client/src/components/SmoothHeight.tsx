import { useLayoutEffect, useRef, type ReactNode } from "react";
import { springEasing } from "../spring";

/**
 * Grows and shrinks with a spring when what's inside changes height (a longer
 * hint, a page switch, a warning appearing), instead of jumping. The inner box
 * keeps its natural height; only the outer one animates.
 */
export default function SmoothHeight({ children, className = "", duration = 440 }: { children: ReactNode; className?: string; duration?: number }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    let last = i.getBoundingClientRect().height;
    let anim: Animation | null = null;
    // Runs after layout, before paint: the jump is never seen.
    const ro = new ResizeObserver(() => {
      const next = i.getBoundingClientRect().height;
      if (Math.abs(next - last) < 1) return;
      // From what's on screen now, so a change mid-animation turns it smoothly.
      const from = anim ? o.getBoundingClientRect().height : last;
      last = next;
      anim?.cancel();
      anim = null;
      if (document.documentElement.hasAttribute("data-reduce-motion")) return;
      // Something inside is already animating its own height (a fold): follow it 1:1.
      const folding = i
        .getAnimations({ subtree: true })
        .some((a) => a.effect instanceof KeyframeEffect && a.effect.getKeyframes().some((k) => "height" in k));
      if (folding) return;
      const frames = [{ height: `${from}px` }, { height: `${next}px` }];
      try {
        anim = o.animate(frames, { duration, easing: springEasing() });
      } catch {
        anim = o.animate(frames, { duration: duration * 0.75, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
      }
      anim.onfinish = () => (anim = null);
    });
    ro.observe(i);
    return () => {
      ro.disconnect();
      anim?.cancel();
    };
  }, [duration]);
  return (
    <div ref={outer} className={`smooth-height ${className}`}>
      <div ref={inner}>{children}</div>
    </div>
  );
}
