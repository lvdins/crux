/**
 * Tiny interruptible springs.
 *
 * Each (element, property) has at most one spring. Re-targeting keeps its
 * current value and velocity, so things can be grabbed or redirected
 * mid-flight without a jump. Parameters follow Apple's damping/response:
 * damping 1 = no overshoot, response = seconds to (roughly) arrive.
 */
type Spring = { x: number; v: number; to: number; k: number; c: number; raf: number; last: number };
export type SpringOpts = { response?: number; damping?: number; velocity?: number; from?: number };

const springs = new WeakMap<object, Map<string, Spring>>();

const reduced = () => document.documentElement.hasAttribute("data-reduce-motion");
const get = (owner: object, name: string) => springs.get(owner)?.get(name);
const drop = (owner: object, name: string) => {
  const s = get(owner, name);
  if (s) cancelAnimationFrame(s.raf);
  springs.get(owner)?.delete(name);
};

/** Spring a named value of `owner` to `to`, calling `apply` every frame. */
export function springValue(owner: object, name: string, to: number, apply: (x: number) => void, opts: SpringOpts & { at?: number } = {}) {
  const { response = 0.3, damping = 1, velocity, from } = opts;
  const cur = get(owner, name);
  const x = from ?? cur?.x ?? opts.at ?? to;
  const v = velocity ?? cur?.v ?? 0;
  drop(owner, name);
  if (reduced() || (Math.abs(x - to) < 0.5 && Math.abs(v) < 10)) return apply(to);
  const w = (2 * Math.PI) / response;
  const s: Spring = { x, v, to, k: w * w, c: 2 * damping * w, raf: 0, last: performance.now() };
  if (!springs.has(owner)) springs.set(owner, new Map());
  springs.get(owner)!.set(name, s);
  apply(x);
  const step = (now: number) => {
    // Fixed small substeps: stable for stiff springs and long frames.
    let dt = Math.min(0.064, (now - s.last) / 1000);
    s.last = now;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240);
      s.v += (-s.k * (s.x - s.to) - s.c * s.v) * h;
      s.x += s.v * h;
      dt -= h;
    }
    if (Math.abs(s.x - s.to) < 0.1 && Math.abs(s.v) < 5) {
      springs.get(owner)?.delete(name);
      return apply(s.to);
    }
    apply(s.x);
    s.raf = requestAnimationFrame(step);
  };
  s.raf = requestAnimationFrame(step);
}

/** Jump a named value straight to `x`, stopping its spring. */
export function setValue(owner: object, name: string, x: number, apply: (x: number) => void) {
  drop(owner, name);
  apply(x);
}

// ---- translateX on an element ----

const writeX = (el: HTMLElement) => (x: number) => {
  el.style.transform = Math.abs(x) < 0.01 ? "" : `translateX(${x}px)`;
};

/** The element's current offset: live spring value, or what's painted. */
export function offsetOf(el: HTMLElement): number {
  const s = get(el, "x");
  if (s) return s.x;
  const m = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform);
  return m ? +m[1] : 0;
}

/** The element's current speed in px/s (0 when at rest). */
export function velocityOf(el: HTMLElement): number {
  return get(el, "x")?.v ?? 0;
}

/** Stop any spring and pin the element at `x` (1:1 tracking). */
export function setOffset(el: HTMLElement, x: number) {
  setValue(el, "x", x, writeX(el));
}

/**
 * Spring the element's translateX to `to`. `from` and `velocity` (px/s)
 * default to the live values, which is what makes it interruptible.
 */
export function springTo(el: HTMLElement, to: number, opts: SpringOpts = {}) {
  springValue(el, "x", to, writeX(el), { ...opts, from: opts.from ?? offsetOf(el) });
}

/** Progressive resistance past a boundary (Apple's rubber-band curve). */
export function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** The CSS `--spring` curve (styles.css), for the Web Animations API. */
export function springEasing(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--spring").trim();
  return v || "cubic-bezier(0.32, 0.72, 0, 1)";
}
