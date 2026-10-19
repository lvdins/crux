// Runs one Wild scene on a canvas: requestAnimationFrame capped at ~30 fps,
// devicePixelRatio aware, frame-time based so speed can change mid-flight.
// Also draws the reactive effects on top (input flash, finished burst).

import type { TermState, WildId } from "../appearance";
import { SCENES } from "./scenes";

export interface WildOptions {
  speed: number;     // 1 = normal; working agents run at 2
  state: TermState;  // informational; the caller maps it to speed/effects
}

export interface WildHandle {
  setSpeed(speed: number): void;
  setState(state: TermState): void;
  /** Run (true) or freeze on the current frame (false). */
  setRunning(on: boolean): void;
  /** Brief light flash (user input). */
  flash(): void;
  /** One ring-and-sparks burst (agent finished). */
  burst(): void;
  stop(): void;
}

const FRAME_MS = 1000 / 30;
// Big canvases cost fill-rate on every frame; cap the backing store.
const MAX_DPR = 2;

/**
 * Start `id` on `ctx`. With `still`, draws a single static frame and never
 * animates (reduce motion); effects are ignored then.
 */
export function start(ctx: CanvasRenderingContext2D, id: WildId, opts: WildOptions, still = false): WildHandle {
  const canvas = ctx.canvas;
  const draw = (SCENES[id] ?? SCENES["neon-sunset"]).create();
  let speed = opts.speed;
  let running = !still;
  let raf = 0;
  let last = 0;
  let t = 3; // start a little in so scenes aren't all at their zero pose
  let w = 0;
  let h = 0;
  let flashAt = -1;
  let burstAt = -1;
  let wall = 0; // unscaled seconds, for effects

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const rect = canvas.getBoundingClientRect();
    const nw = Math.max(1, Math.round(rect.width));
    const nh = Math.max(1, Math.round(rect.height));
    if (nw === w && nh === h && canvas.width === Math.round(nw * dpr)) return false;
    w = nw;
    h = nh;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  };

  const effects = () => {
    if (flashAt >= 0) {
      const k = (wall - flashAt) / 0.18;
      if (k >= 1) flashAt = -1;
      else {
        ctx.fillStyle = `rgba(255,255,255,${0.14 * (1 - k)})`;
        ctx.fillRect(0, 0, w, h);
      }
    }
    if (burstAt >= 0) {
      const k = (wall - burstAt) / 1.2;
      if (k >= 1) burstAt = -1;
      else {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.max(w, h) * 0.6 * k;
        ctx.save();
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          const d = r * (0.6 + ((i * 37) % 10) / 25);
          ctx.fillStyle = `hsl(${i * 15} 100% 70%)`;
          ctx.fillRect(cx + Math.cos(a) * d - 2, cy + Math.sin(a) * d - 2, 4, 4);
        }
        ctx.restore();
      }
    }
  };

  const frame = (dt: number) => {
    resize();
    t += dt * speed;
    wall += dt;
    draw(ctx, w, h, t, dt * speed);
    effects();
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (!last) last = now;
    const elapsed = now - last;
    if (elapsed < FRAME_MS - 2) return;
    last = now;
    // Clamp so a long pause (tab hidden) doesn't jump the scene.
    frame(Math.min(elapsed, 100) / 1000);
  };

  const run = () => {
    if (raf || !running) return;
    last = 0;
    raf = requestAnimationFrame(loop);
  };
  const halt = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  // Still frames re-render on resize so they stay sharp.
  const ro = new ResizeObserver(() => {
    if (!raf && resize()) frame(0);
  });
  ro.observe(canvas);

  frame(0);
  if (still) {
    // Matrix-style trail scenes need a few steps to look like anything.
    for (let i = 0; i < 20; i++) frame(FRAME_MS / 1000);
  }
  run();

  return {
    setSpeed: (s) => {
      speed = Math.max(0, s);
    },
    setState: () => {},
    setRunning: (on) => {
      running = on && !still;
      if (running) run();
      else halt();
    },
    flash: () => {
      if (still) return;
      flashAt = wall;
    },
    burst: () => {
      if (still) return;
      burstAt = wall;
    },
    stop: () => {
      halt();
      ro.disconnect();
    },
  };
}
