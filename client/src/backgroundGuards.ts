// Guardrails for terminal backgrounds: file limits, safe asset names and a
// WCAG contrast estimate (text colour over the effective background).

import type { Background, BackgroundStyle } from "./appearance";
import { assetUrl } from "./themeAssets";
import { SCENES } from "./wild/scenes";

export const MAX_BG_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_W = 1920;
export const MAX_VIDEO_H = 1080;
/** Today's terminal background: what shows through a semi-transparent layer. */
export const TERM_BASE_BG = "#1b1c20";

/**
 * Local asset URL for a background, or null when the name isn't a plain file
 * name. Backgrounds never load remote URLs: anything with a scheme, a path or
 * "..".
 */
export function safeAssetUrl(name: string | undefined): string | null {
  if (!name || name.length > 255) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(name) || /[\\/]/.test(name) || name.includes("..") || name.startsWith(".")) return null;
  return assetUrl(name);
}

/** Error message for a file that can't be a background, or null if it's fine. */
export async function validateBackgroundFile(file: File): Promise<string | null> {
  if (file.size > MAX_BG_BYTES) return `That file is ${(file.size / 1048576).toFixed(1)} MB; backgrounds can be up to 20 MB.`;
  const type = file.type || "";
  const isVideo = type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
  const isImage = type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name);
  if (!isVideo && !isImage) return "Pick an image, GIF or video file.";
  if (!isVideo) return null;
  const url = URL.createObjectURL(file);
  try {
    const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const done = (r: { w: number; h: number } | null) => {
        clearTimeout(timer);
        v.removeAttribute("src");
        v.load();
        resolve(r);
      };
      const timer = setTimeout(() => done(null), 10_000);
      v.onloadedmetadata = () => done({ w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => done(null);
      v.src = url;
    });
    if (!dims || !dims.w) return "Couldn't read that video. Try an MP4 (H.264) or WebM file.";
    // Portrait 1080×1920 is as heavy as landscape 1920×1080, so compare long/short sides.
    const long = Math.max(dims.w, dims.h);
    const short = Math.min(dims.w, dims.h);
    if (long > MAX_VIDEO_W || short > MAX_VIDEO_H) return `That video is ${dims.w}×${dims.h}; backgrounds can be up to 1920×1080.`;
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- colour maths -----------------------------------------------------------

export type RGB = [number, number, number];

let probe: CanvasRenderingContext2D | null | undefined;
/** Parse a CSS colour (hex fast path; anything else via the browser). */
export function parseColor(c: string): RGB | null {
  const s = c.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  if (typeof document === "undefined") return null;
  if (probe === undefined) probe = document.createElement("canvas").getContext("2d");
  if (!probe) return null;
  probe.fillStyle = "#000001";
  probe.fillStyle = s;
  const norm = String(probe.fillStyle);
  if (norm === "#000001") return null;
  if (norm.startsWith("#")) return parseColor(norm);
  const nums = norm.match(/[\d.]+/g)?.map(Number);
  return nums && nums.length >= 3 ? [nums[0], nums[1], nums[2]] : null;
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratioOf(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG 2 contrast ratio between two CSS colours (1–21). Unparseable → 1. */
export function contrastRatio(fg: string, bg: string): number {
  const a = parseColor(fg);
  const b = parseColor(bg);
  return a && b ? ratioOf(a, b) : 1;
}

const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

// ---- sampled backgrounds ------------------------------------------------------

const samples = new Map<string, RGB>();
const sampleKey = (bg: Background): string | null =>
  bg.kind === "image" || bg.kind === "gif" || bg.kind === "video" ? `${bg.kind}:${bg.asset}` : bg.kind === "wild" ? `wild:${bg.id}` : null;

function averageOf(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w = 48, h = 30): RGB | null {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    draw(ctx, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let r = 0, g = 0, b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    return [r / n, g / n, b / n];
  } catch {
    return null; // tainted canvas or similar: keep the conservative guess
  }
}

/** Average colour of a media/wild background (cached). Null if it can't be sampled. */
export async function sampleBackground(bg: Background): Promise<RGB | null> {
  const key = sampleKey(bg);
  if (!key) return null;
  const hit = samples.get(key);
  if (hit) return hit;
  let out: RGB | null = null;
  if (bg.kind === "wild") {
    const scene = SCENES[bg.id];
    if (!scene) return null;
    const draw = scene.create();
    out = averageOf((ctx, w, h) => {
      for (let i = 0; i < 12; i++) draw(ctx, w, h, 3 + i / 30, 1 / 30);
    }, 96, 60);
  } else if (bg.kind === "image" || bg.kind === "gif" || bg.kind === "video") {
    const url = safeAssetUrl(bg.asset);
    if (!url) return null;
    out = await new Promise<RGB | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      const finish = (el: CanvasImageSource) => {
        clearTimeout(timer);
        resolve(averageOf((ctx, w, h) => ctx.drawImage(el, 0, 0, w, h)));
      };
      if (bg.kind === "video") {
        const v = document.createElement("video");
        v.muted = true;
        v.preload = "auto";
        v.onloadeddata = () => finish(v);
        v.onerror = () => resolve(null);
        v.src = url;
      } else {
        const img = new Image();
        img.onload = () => finish(img);
        img.onerror = () => resolve(null);
        img.src = url;
      }
    });
  }
  if (out) samples.set(key, out);
  return out;
}

/** The background's own colours: worst-case stops for gradients, a sample or a guess for the rest. */
function backgroundColors(bg: Background): RGB[] | null {
  switch (bg.kind) {
    case "none":
      return null;
    case "solid": {
      const c = parseColor(bg.color);
      return c ? [c] : null;
    }
    case "gradient": {
      const cs = [parseColor(bg.from), parseColor(bg.to)].filter(Boolean) as RGB[];
      return cs.length ? cs : null;
    }
    case "wild": {
      const s = samples.get(`wild:${bg.id}`);
      const avg = s ?? parseColor(SCENES[bg.id]?.avg ?? "#808080");
      return avg ? [avg] : null;
    }
    default: {
      // Media not sampled yet: assume a fairly bright picture (conservative).
      const s = samples.get(`${bg.kind}:${bg.asset}`);
      return [s ?? [180, 180, 180]];
    }
  }
}

/** Effective colour behind the text: base → background at opacity → black dim. */
function effective(c: RGB, style: BackgroundStyle, dim: number, base: RGB): RGB {
  const o = Math.min(100, Math.max(0, style.opacity)) / 100;
  return mix(mix(base, c, o), [0, 0, 0], Math.min(90, Math.max(0, dim)) / 100);
}

export interface ContrastResult {
  ratio: number;
  ok: boolean;
  /** Dim (0–90) that reaches 4.5:1, or the current dim when dimming can't help. */
  suggestedDim: number;
}

/**
 * Estimate text contrast over a background. Null for "none" (today's look) or
 * unparseable colours. Gradients use their worst stop; media and Wild scenes
 * use a sampled average once `sampleBackground` has run, else a cautious guess.
 */
export function contrastWarning(fgHex: string, bg: Background, style: BackgroundStyle, baseHex = TERM_BASE_BG): ContrastResult | null {
  const fg = parseColor(fgHex);
  const base = parseColor(baseHex) ?? [27, 28, 32];
  const colors = backgroundColors(bg);
  if (!fg || !colors) return null;
  const worst = (dim: number) => Math.min(...colors.map((c) => ratioOf(fg, effective(c, style, dim, base))));
  const ratio = worst(style.dim);
  const ok = ratio >= 4.5;
  let suggestedDim = style.dim;
  // Dimming darkens the background, which only helps light text.
  if (!ok && luminance(fg) > 0.18) {
    suggestedDim = 90;
    for (let d = Math.ceil(style.dim / 5) * 5; d <= 90; d += 5) {
      if (worst(d) >= 4.5) {
        suggestedDim = d;
        break;
      }
    }
  }
  return { ratio: Math.round(ratio * 100) / 100, ok, suggestedDim };
}
