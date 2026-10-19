// The Wild pack: procedural backgrounds drawn on one <canvas>. Each scene is a
// factory returning a draw function; `t` is scaled time in seconds (speed is
// applied by the engine), so scenes stay smooth when speed changes. They sit
// behind every terminal, so each frame has to stay cheap: no shadowBlur, no
// per-pixel work, a few dozen shapes at most.

import type { WildId } from "../appearance";

/** Draws one frame. w/h are CSS pixels (the engine scales for devicePixelRatio). */
export type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, dt: number) => void;
export interface Scene {
  name: string;
  /** Rough average colour, used by the contrast check before a sample exists. */
  avg: string;
  create: () => DrawFn;
}

/** Small deterministic PRNG so a scene looks the same each time it starts. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const TAU = Math.PI * 2;

/** Perspective floor grid that scrolls towards the viewer. */
function floorGrid(ctx: CanvasRenderingContext2D, w: number, h: number, horizon: number, t: number, color: string, alpha: number) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const depth = h - horizon;
  // Horizontal lines bunch up towards the horizon.
  const shift = (t * 0.6) % 1;
  for (let i = 0; i < 14; i++) {
    const z = (i + shift) / 14;
    const y = horizon + depth * z * z;
    ctx.globalAlpha = alpha * z;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // Vertical lines fan out from the vanishing point.
  ctx.globalAlpha = alpha * 0.8;
  const cx = w / 2;
  for (let i = -12; i <= 12; i++) {
    ctx.beginPath();
    ctx.moveTo(cx + i * 6, horizon);
    ctx.lineTo(cx + i * (w / 7), h);
    ctx.stroke();
  }
  ctx.restore();
}

const neonSunset: Scene = {
  name: "Neon Sunset",
  avg: "#3a1846",
  create: () => (ctx, w, h, t) => {
    const horizon = h * 0.62;
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, "#120726");
    sky.addColorStop(0.6, "#4a0f5c");
    sky.addColorStop(1, "#ff5f6d");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);
    // Striped sun sinking into the horizon, bands drifting down.
    const r = Math.min(w, h) * 0.22;
    const cx = w / 2;
    const cy = horizon - r * 0.35;
    const sun = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    sun.addColorStop(0, "#ffe66d");
    sun.addColorStop(0.5, "#ff9a3c");
    sun.addColorStop(1, "#ff2e88");
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.clip();
    ctx.fillStyle = sun;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = "#4a0f5c";
    const off = (t * 8) % 14;
    for (let y = cy; y < cy + r; y += 14) {
      const k = (y - cy) / r;
      ctx.fillRect(cx - r, y + off, r * 2, 2 + k * 6);
    }
    ctx.restore();
    const floor = ctx.createLinearGradient(0, horizon, 0, h);
    floor.addColorStop(0, "#2b0838");
    floor.addColorStop(1, "#0b0316");
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizon, w, h - horizon);
    floorGrid(ctx, w, h, horizon, t, "#ff3fb4", 0.75);
  },
};

const glitchOverdrive: Scene = {
  name: "Glitch Overdrive",
  avg: "#141322",
  create: () => {
    let seed = 7;
    let next = 0;
    let slices: { y: number; hgt: number; dx: number; color: string }[] = [];
    return (ctx, w, h, t) => {
      ctx.fillStyle = "#0b0a14";
      ctx.fillRect(0, 0, w, h);
      // New glitch pattern every ~120 ms of scene time.
      if (t >= next || t < next - 1) {
        next = t + 0.12;
        const r = rng(seed++);
        const n = 6 + Math.floor(r() * 10);
        slices = Array.from({ length: n }, () => ({
          y: r() * h,
          hgt: 2 + r() * 26,
          dx: (r() - 0.5) * w * 0.3,
          color: ["#00f0ff", "#ff2bd6", "#f5f749", "#7b2cff"][Math.floor(r() * 4)],
        }));
      }
      // A slow diagonal colour wash underneath.
      const g = ctx.createLinearGradient(0, 0, w, h);
      const p = (Math.sin(t * 0.7) + 1) / 2;
      g.addColorStop(0, "rgba(123,44,255,0.25)");
      g.addColorStop(p, "rgba(0,240,255,0.12)");
      g.addColorStop(1, "rgba(255,43,214,0.25)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (const s of slices) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = s.color;
        ctx.fillRect(s.dx, s.y, w * 0.6, s.hgt);
        // RGB split: offset twin in a second colour.
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = "#ff2bd6";
        ctx.fillRect(s.dx + 6, s.y + 2, w * 0.4, s.hgt * 0.5);
      }
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = "#000";
      for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
      ctx.globalAlpha = 1;
    };
  },
};

const matrixRainbow: Scene = {
  name: "Matrix Rainbow",
  avg: "#0a140e",
  create: () => {
    const glyphs = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789ABCDEF<>/{}";
    const size = 14;
    let drops: number[] = [];
    let cols = 0;
    let acc = 0;
    let first = true;
    return (ctx, w, h, t, dt) => {
      const n = Math.ceil(w / size);
      if (n !== cols || first) {
        const r = rng(42);
        cols = n;
        drops = Array.from({ length: n }, () => r() * (h / size));
        ctx.fillStyle = "#040806";
        ctx.fillRect(0, 0, w, h);
        first = false;
      }
      // Fade the previous frame for the trails.
      ctx.fillStyle = "rgba(4,8,6,0.12)";
      ctx.fillRect(0, 0, w, h);
      acc += dt * 18; // rows per scene-second
      const steps = Math.floor(acc);
      acc -= steps;
      ctx.font = `${size}px ui-monospace, Menlo, monospace`;
      for (let i = 0; i < cols; i++) {
        const hue = (i * 9 + t * 40) % 360;
        ctx.fillStyle = `hsl(${hue} 100% 62%)`;
        const ch = glyphs[(i * 7 + Math.floor(drops[i] * 3)) % glyphs.length];
        ctx.fillText(ch, i * size, drops[i] * size);
        drops[i] += steps;
        if (drops[i] * size > h && (i * 31 + Math.floor(t * 10)) % 7 === 0) drops[i] = 0;
      }
    };
  },
};

const hologramUnicorn: Scene = {
  name: "Hologram Unicorn",
  avg: "#a99ad6",
  create: () => {
    const r = rng(3);
    const stars = Array.from({ length: 40 }, () => ({ x: r(), y: r(), p: r() * TAU }));
    return (ctx, w, h, t) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      const shift = t * 30;
      for (let i = 0; i <= 4; i++) g.addColorStop(i / 4, `hsl(${(shift + i * 70) % 360} 75% 72%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // Iridescent sheen bands sliding across.
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#fff";
      const band = Math.max(w, h) * 0.18;
      const x0 = ((t * 60) % (w + h + band * 2)) - band - h;
      for (let k = 0; k < 3; k++) {
        const x = x0 + k * (band * 2.2);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + band, 0);
        ctx.lineTo(x + band + h, h);
        ctx.lineTo(x + h, h);
        ctx.fill();
      }
      ctx.restore();
      // Twinkling sparkles.
      ctx.fillStyle = "#fff";
      for (const s of stars) {
        const a = (Math.sin(t * 3 + s.p) + 1) / 2;
        const sz = 1 + a * 2.5;
        ctx.globalAlpha = a * 0.9;
        ctx.fillRect(s.x * w - sz / 2, s.y * h - 0.5, sz, 1);
        ctx.fillRect(s.x * w - 0.5, s.y * h - sz / 2, 1, sz);
      }
      ctx.globalAlpha = 1;
    };
  },
};

const nightMarket: Scene = {
  name: "Night Market",
  avg: "#1d1420",
  create: () => {
    const r = rng(11);
    const lights = Array.from({ length: 34 }, () => ({
      x: r(),
      y: r() * 0.8,
      rad: 10 + r() * 38,
      hue: [8, 24, 40, 340, 190][Math.floor(r() * 5)],
      sp: 0.01 + r() * 0.03,
      ph: r() * TAU,
    }));
    return (ctx, w, h, t) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#0b0d1f");
      g.addColorStop(1, "#24121c");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // Lantern string across the top.
      ctx.strokeStyle = "rgba(255,200,120,0.25)";
      ctx.beginPath();
      ctx.moveTo(0, h * 0.08);
      ctx.quadraticCurveTo(w / 2, h * 0.2, w, h * 0.08);
      ctx.stroke();
      for (let i = 0; i < 9; i++) {
        const x = ((i + 0.5) / 9) * w;
        const k = (x / w) * 2 - 1;
        const y = h * 0.08 + h * 0.12 * (1 - k * k) + 10;
        const flick = 0.75 + 0.25 * Math.sin(t * 4 + i * 1.7);
        ctx.fillStyle = `rgba(255,${90 + i * 12},60,${0.85 * flick})`;
        ctx.beginPath();
        ctx.ellipse(x, y, 7, 10, 0, 0, TAU);
        ctx.fill();
      }
      // Soft drifting bokeh.
      for (const l of lights) {
        const x = ((l.x + t * l.sp) % 1.2) * w - w * 0.1;
        const y = l.y * h + Math.sin(t * 0.5 + l.ph) * 8 + h * 0.15;
        const rg = ctx.createRadialGradient(x, y, 0, x, y, l.rad);
        rg.addColorStop(0, `hsla(${l.hue} 95% 62% / 0.45)`);
        rg.addColorStop(1, `hsla(${l.hue} 95% 62% / 0)`);
        ctx.fillStyle = rg;
        ctx.fillRect(x - l.rad, y - l.rad, l.rad * 2, l.rad * 2);
      }
    };
  },
};

const laserGrid: Scene = {
  name: "Laser Grid",
  avg: "#050d10",
  create: () => (ctx, w, h, t) => {
    ctx.fillStyle = "#03060a";
    ctx.fillRect(0, 0, w, h);
    const horizon = h * 0.45;
    floorGrid(ctx, w, h, horizon, t * 1.4, "#00ffd0", 0.7);
    // Mirrored ceiling grid.
    ctx.save();
    ctx.translate(0, horizon * 2);
    ctx.scale(1, -1);
    floorGrid(ctx, w, horizon * 2, horizon, t * 1.4, "#2f7bff", 0.35);
    ctx.restore();
    // Sweeping beams from the bottom corners.
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const a = Math.sin(t * (0.6 + i * 0.17) + i) * 0.6;
      const fromX = i % 2 ? w : 0;
      const dir = i % 2 ? -1 : 1;
      const ex = fromX + dir * Math.cos(a) * w * 1.2;
      const ey = h - Math.abs(Math.sin(a + 1)) * h * 1.1;
      ctx.strokeStyle = i % 2 ? "rgba(255,40,120,0.55)" : "rgba(0,255,208,0.55)";
      ctx.beginPath();
      ctx.moveTo(fromX, h);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    const glow = ctx.createLinearGradient(0, horizon - 30, 0, horizon + 30);
    glow.addColorStop(0, "rgba(0,255,208,0)");
    glow.addColorStop(0.5, "rgba(0,255,208,0.25)");
    glow.addColorStop(1, "rgba(0,255,208,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, horizon - 30, w, 60);
  },
};

const pinkDream: Scene = {
  name: "Pink Dream",
  avg: "#e7a9c8",
  create: () => {
    const r = rng(23);
    const blobs = Array.from({ length: 6 }, () => ({ x: r(), y: r(), rad: 0.3 + r() * 0.4, sp: 0.1 + r() * 0.2, ph: r() * TAU, hue: 300 + r() * 50 }));
    const bubbles = Array.from({ length: 24 }, () => ({ x: r(), y: r(), s: 3 + r() * 9, sp: 0.02 + r() * 0.05 }));
    return (ctx, w, h, t) => {
      ctx.fillStyle = "#f6c6dc";
      ctx.fillRect(0, 0, w, h);
      const m = Math.max(w, h);
      for (const b of blobs) {
        const x = (b.x + Math.sin(t * b.sp + b.ph) * 0.2) * w;
        const y = (b.y + Math.cos(t * b.sp * 1.3 + b.ph) * 0.2) * h;
        const rad = b.rad * m;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, `hsla(${b.hue % 360} 90% 78% / 0.7)`);
        g.addColorStop(1, `hsla(${b.hue % 360} 90% 78% / 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      for (const b of bubbles) {
        const y = (((b.y - t * b.sp) % 1) + 1) % 1;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(b.x * w + Math.sin(t + b.y * 9) * 6, y * h, b.s, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
  },
};

const neonPink: Scene = {
  name: "Neon Pink",
  avg: "#1c0a1a",
  create: () => (ctx, w, h, t) => {
    ctx.fillStyle = "#0d0510";
    ctx.fillRect(0, 0, w, h);
    // Flowing neon tubes: each is a sine ribbon drawn wide-faint then thin-bright
    // (cheap fake glow instead of shadowBlur).
    const pulse = 0.75 + 0.25 * Math.sin(t * 2.2);
    for (let k = 0; k < 4; k++) {
      const base = h * (0.2 + k * 0.2);
      const amp = h * 0.06 * (1 + k * 0.3);
      const passes: [number, string][] = [
        [10, `rgba(255,46,160,${0.08 * pulse})`],
        [4, `rgba(255,70,190,${0.25 * pulse})`],
        [1.5, `rgba(255,190,235,${0.9 * pulse})`],
      ];
      for (const [lw, col] of passes) {
        ctx.lineWidth = lw;
        ctx.strokeStyle = col;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 12) {
          const y = base + Math.sin(x * 0.008 + t * (0.8 + k * 0.2) + k) * amp;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
  },
};

export const SCENES: Record<WildId, Scene> = {
  "neon-sunset": neonSunset,
  "glitch-overdrive": glitchOverdrive,
  "matrix-rainbow": matrixRainbow,
  "hologram-unicorn": hologramUnicorn,
  "night-market": nightMarket,
  "laser-grid": laserGrid,
  "pink-dream": pinkDream,
  "neon-pink": neonPink,
};

export const WILD_IDS = Object.keys(SCENES) as WildId[];
