// A layer behind one terminal: solid, gradient, image/GIF, video or a Wild
// scene, with fit / opacity / blur / dim. Renders nothing for "none", so the
// default look (and cost) is exactly today's.
//
// Terminal transparency: while a background is active the terminal must not
// paint its own background. This module keeps the set of terminals that want
// it (`termWantsTransparency`) and fires TERM_TRANSPARENT_EVENT {id, on} on
// window whenever that changes; Term.tsx turns xterm's background transparent
// in response.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  APPEARANCE_EVENT,
  SAFE_MODE_KEY,
  TERM_STATE_EVENT,
  resolveLook,
  withDefaults,
  type Appearance,
  type Background,
  type BackgroundStyle,
  type BgFit,
  type ChatKind,
  type Playlist,
  type TermLook,
  type TermStateDetail,
  type WildId,
} from "../appearance";
import { contrastWarning, parseColor, safeAssetUrl, sampleBackground } from "../backgroundGuards";
import { start, type WildHandle } from "../wild/engine";
import { pickWild } from "../wild/playlist";
import "./terminalBackground.css";

export { validateBackgroundFile, contrastRatio, contrastWarning, sampleBackground } from "../backgroundGuards";
export type { ContrastResult } from "../backgroundGuards";

export const APPEARANCE_KEY = "crux.appearance";
/** window CustomEvent<{ id: string; on: boolean }>: terminal `id` should (not) be see-through. */
export const TERM_TRANSPARENT_EVENT = "crux:term-transparent";
export interface TermTransparentDetail { id: string; on: boolean }
/** window CustomEvent<{ id: string }>: the user typed into terminal `id` (optional; keydown in the pane works too). */
export const TERM_INPUT_EVENT = "crux:term-input";

// ---- terminal transparency ----------------------------------------------------

const transparentTerms = new Set<string>();
/** True while a background is shown behind terminal `id` (for Term.tsx at xterm creation). */
export function termWantsTransparency(id: string): boolean {
  return transparentTerms.has(id);
}
function setTransparency(id: string, on: boolean) {
  if (transparentTerms.has(id) === on) return;
  if (on) transparentTerms.add(id);
  else transparentTerms.delete(id);
  window.dispatchEvent(new CustomEvent<TermTransparentDetail>(TERM_TRANSPARENT_EVENT, { detail: { id, on } }));
}

// ---- shared stores (one window listener however many terminals) ---------------

function loadAppearance(): Appearance {
  try {
    // ⌥ at launch: ignore the saved look for this run (live edits still apply).
    if (localStorage.getItem(SAFE_MODE_KEY)) return withDefaults();
    const raw = localStorage.getItem(APPEARANCE_KEY);
    return withDefaults(raw ? (JSON.parse(raw) as Partial<Appearance>) : null);
  } catch {
    return withDefaults();
  }
}

function makeStore<T>(read: () => T, attach: (changed: () => void) => () => void) {
  let value = read();
  const subs = new Set<() => void>();
  let detach: (() => void) | null = null;
  const changed = () => {
    value = read();
    subs.forEach((s) => s());
  };
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      subs.forEach((s) => s());
    },
    subscribe: (s: () => void) => {
      subs.add(s);
      if (!detach) {
        value = read();
        detach = attach(changed);
      }
      return () => {
        subs.delete(s);
        if (!subs.size && detach) {
          detach();
          detach = null;
        }
      };
    },
  };
}

let latestAppearance: Appearance | null = null;
const appearanceStore = makeStore<Appearance>(
  () => latestAppearance ?? (latestAppearance = loadAppearance()),
  () => {
    const on = (e: Event) => {
      latestAppearance = withDefaults((e as CustomEvent<Appearance>).detail);
      appearanceStore.set(latestAppearance);
    };
    window.addEventListener(APPEARANCE_EVENT, on);
    return () => window.removeEventListener(APPEARANCE_EVENT, on);
  },
);
function useAppearance(): Appearance {
  return useSyncExternalStore(appearanceStore.subscribe, appearanceStore.get);
}

// Visible and focused: animations and video pause otherwise.
const activeStore = makeStore(
  () => typeof document !== "undefined" && !document.hidden && document.hasFocus(),
  (changed) => {
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("focus", changed);
    window.addEventListener("blur", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("focus", changed);
      window.removeEventListener("blur", changed);
    };
  },
);
const usePageActive = () => useSyncExternalStore(activeStore.subscribe, activeStore.get);

const motionQuery = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;
const motionStore = makeStore(
  () => !!motionQuery?.matches,
  (changed) => {
    motionQuery?.addEventListener?.("change", changed);
    return () => motionQuery?.removeEventListener?.("change", changed);
  },
);
const useOsReducedMotion = () => useSyncExternalStore(motionStore.subscribe, motionStore.get);

// ---- the layer ---------------------------------------------------------------

export interface TerminalBackgroundProps {
  termId: string;
  /** Workspace (repo key) for per-workspace looks. */
  repo?: string;
  kind?: ChatKind;
  /** Per-session look (TermTab.look). */
  look?: TermLook;
}

/** Can this background actually be shown? (bad colours / unsafe names render nothing) */
function renderable(bg: Background): boolean {
  switch (bg.kind) {
    case "none":
      return false;
    case "solid":
      return !!parseColor(bg.color);
    case "gradient":
      return !!parseColor(bg.from) && !!parseColor(bg.to);
    case "wild":
      return true;
    default:
      return !!safeAssetUrl(bg.asset);
  }
}

export default function TerminalBackground({ termId, repo, kind, look }: TerminalBackgroundProps) {
  const appearance = useAppearance();
  const { background, backgroundStyle } = resolveLook(appearance, { session: look, repo, kind });
  const active = renderable(background);

  useEffect(() => {
    setTransparency(termId, active);
  }, [termId, active]);
  useEffect(() => () => setTransparency(termId, false), [termId]);

  if (!active || background.kind === "none") return null;
  return (
    <ActiveBackground
      termId={termId}
      background={background}
      style={backgroundStyle}
      playlist={background.kind === "wild" ? appearance.playlist : undefined}
      reduceMotion={appearance.reduceMotion}
      reactToState={appearance.reactToState}
    />
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
}

function ActiveBackground({
  termId,
  background,
  style,
  playlist,
  reduceMotion,
  reactToState,
}: {
  termId: string;
  background: Exclude<Background, { kind: "none" }>;
  style: BackgroundStyle;
  playlist?: Playlist;
  reduceMotion: boolean;
  reactToState: boolean;
}) {
  const pageActive = usePageActive();
  const still = useOsReducedMotion() || reduceMotion;
  const blur = clamp(style.blur, 0, 20);
  const dim = clamp(style.dim, 0, 90);
  const layerStyle: React.CSSProperties = {
    opacity: clamp(style.opacity, 0, 100) / 100,
    // Blur pulls transparent edges in; bleed the layer past the pane instead.
    ...(blur ? { filter: `blur(${blur}px)`, inset: -blur * 2 } : {}),
  };

  let layer: React.ReactNode;
  switch (background.kind) {
    case "solid":
      layer = <div className="term-bg-layer" style={{ ...layerStyle, background: background.color }} />;
      break;
    case "gradient":
      layer = (
        <div
          className="term-bg-layer"
          style={{ ...layerStyle, background: `linear-gradient(${clamp(background.angle, -360, 360)}deg, ${background.from}, ${background.to})` }}
        />
      );
      break;
    case "image":
    case "gif":
      layer = <ImageLayer url={safeAssetUrl(background.asset)!} fit={style.fit} freeze={background.kind === "gif" && (still || !pageActive)} style={layerStyle} />;
      break;
    case "video":
      layer = <VideoLayer url={safeAssetUrl(background.asset)!} fit={style.fit} playing={pageActive && !still} style={layerStyle} />;
      break;
    case "wild":
      layer = (
        <WildLayer termId={termId} baseId={background.id} playlist={playlist} running={pageActive} still={still} react={reactToState && !still} style={layerStyle} />
      );
      break;
  }
  return (
    <div className="term-bg" aria-hidden>
      {layer}
      {dim > 0 && <div className="term-bg-dim" style={{ background: `rgba(0,0,0,${dim / 100})` }} />}
    </div>
  );
}

function bgSize(fit: BgFit): React.CSSProperties {
  switch (fit) {
    case "contain":
      return { backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center" };
    case "tile":
      return { backgroundSize: "auto", backgroundRepeat: "repeat", backgroundPosition: "top left" };
    case "center":
      return { backgroundSize: "auto", backgroundRepeat: "no-repeat", backgroundPosition: "center" };
    default:
      return { backgroundSize: "cover", backgroundRepeat: "no-repeat", backgroundPosition: "center" };
  }
}

/** Image or GIF. A frozen GIF shows its first frame (drawn once to a canvas). */
function ImageLayer({ url, fit, freeze, style }: { url: string; fit: BgFit; freeze: boolean; style: React.CSSProperties }) {
  const [still, setStill] = useState<string | null>(null);
  useEffect(() => {
    setStill(null);
    if (!freeze) return;
    let gone = false;
    const img = new Image();
    img.onload = () => {
      if (gone) return;
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d")?.drawImage(img, 0, 0);
        setStill(c.toDataURL());
      } catch {
        /* can't freeze: leave the layer empty rather than animate */
      }
    };
    img.src = url;
    return () => {
      gone = true;
    };
  }, [url, freeze]);
  const src = freeze ? still : url;
  if (!src) return null;
  return <div className="term-bg-layer" style={{ ...style, ...bgSize(fit), backgroundImage: `url("${src.replace(/"/g, "%22")}")` }} />;
}

function VideoLayer({ url, fit, playing, style }: { url: string; fit: BgFit; playing: boolean; style: React.CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing) void v.play().catch(() => {});
    else v.pause();
  }, [playing, url]);
  const objectFit = fit === "contain" ? "contain" : fit === "center" ? "none" : "cover";
  return (
    <video
      ref={ref}
      className="term-bg-layer term-bg-video"
      src={url}
      muted
      loop
      playsInline
      preload="auto"
      disablePictureInPicture
      style={{ ...style, objectFit }}
    />
  );
}

// ---- Wild ------------------------------------------------------------------

function WildLayer({
  termId,
  baseId,
  playlist,
  running,
  still,
  react,
  style,
}: {
  termId: string;
  baseId: WildId;
  playlist?: Playlist;
  running: boolean;
  still: boolean;
  react: boolean;
  style: React.CSSProperties;
}) {
  const playlistKey = playlist?.ids.length ? `${playlist.ids.join(",")}|${playlist.every}|${playlist.order}` : "";
  const pick = () => (playlist?.ids.length ? pickWild(playlist, termId) : null) ?? { id: baseId, nextChangeIn: Infinity };
  const [current, setCurrent] = useState<WildId>(() => pick().id);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const p = pick();
      setCurrent(p.id);
      if (Number.isFinite(p.nextChangeIn)) timer = setTimeout(tick, p.nextChangeIn + 50);
    };
    tick();
    return () => clearTimeout(timer);
  }, [playlistKey, baseId, termId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Crossfade: the new scene fades in over the old one, which then goes.
  const [layers, setLayers] = useState<{ id: WildId; key: number }[]>(() => [{ id: current, key: 0 }]);
  useEffect(() => {
    setLayers((ls) => (ls[ls.length - 1]?.id === current ? ls : [...ls, { id: current, key: (ls[ls.length - 1]?.key ?? 0) + 1 }]));
  }, [current]);
  useEffect(() => {
    if (layers.length < 2) return;
    const t = setTimeout(() => setLayers((ls) => ls.slice(-1)), still ? 0 : 1100);
    return () => clearTimeout(t);
  }, [layers, still]);

  // Agent state → speed and effects.
  const [speed, setSpeed] = useState(1);
  const [flashTick, setFlashTick] = useState(0);
  const [burstTick, setBurstTick] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!react) {
      setSpeed(1);
      return;
    }
    const onState = (e: Event) => {
      const d = (e as CustomEvent<TermStateDetail>).detail;
      if (d?.id !== termId) return;
      setSpeed(d.state === "working" ? 2 : 1);
      if (d.state === "finished") setBurstTick((n) => n + 1);
    };
    let lastFlash = 0;
    const onInput = () => {
      const now = performance.now();
      if (now - lastFlash < 120) return;
      lastFlash = now;
      setFlashTick((n) => n + 1);
    };
    const onInputEvent = (e: Event) => {
      if ((e as CustomEvent<{ id: string }>).detail?.id === termId) onInput();
    };
    // Keys typed into this pane's terminal bubble up to the slot we sit in.
    const pane = anchor.current?.closest(".term-slot") ?? anchor.current?.parentElement?.parentElement;
    window.addEventListener(TERM_STATE_EVENT, onState);
    window.addEventListener(TERM_INPUT_EVENT, onInputEvent);
    pane?.addEventListener("keydown", onInput);
    return () => {
      window.removeEventListener(TERM_STATE_EVENT, onState);
      window.removeEventListener(TERM_INPUT_EVENT, onInputEvent);
      pane?.removeEventListener("keydown", onInput);
    };
  }, [react, termId]);

  return (
    <div className="term-bg-layer term-bg-wild" style={style} ref={anchor}>
      {layers.map((l, i) => (
        <WildCanvas
          key={l.key}
          id={l.id}
          fresh={i > 0 && !still}
          running={running && (i === layers.length - 1 || !still)}
          still={still}
          speed={speed}
          flashTick={i === layers.length - 1 ? flashTick : 0}
          burstTick={i === layers.length - 1 ? burstTick : 0}
        />
      ))}
    </div>
  );
}

function WildCanvas({
  id,
  fresh,
  running,
  still,
  speed,
  flashTick,
  burstTick,
}: {
  id: WildId;
  fresh: boolean;
  running: boolean;
  still: boolean;
  speed: number;
  flashTick: number;
  burstTick: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<WildHandle | null>(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const h = start(ctx, id, { speed: speedRef.current, state: "idle" }, still);
    h.setRunning(runningRef.current);
    handle.current = h;
    return () => {
      h.stop();
      handle.current = null;
    };
  }, [id, still]);
  useEffect(() => handle.current?.setRunning(running), [running]);
  useEffect(() => handle.current?.setSpeed(speed), [speed]);
  const seen = useRef({ flashTick, burstTick });
  useEffect(() => {
    if (flashTick !== seen.current.flashTick) handle.current?.flash();
    if (burstTick !== seen.current.burstTick) handle.current?.burst();
    seen.current = { flashTick, burstTick };
  }, [flashTick, burstTick]);
  return <canvas ref={ref} className={`term-bg-canvas ${fresh ? "fresh" : ""}`} />;
}

// ---- contrast warning (for the settings page) -------------------------------

export interface ContrastWarningProps {
  /** Terminal text colour (the scheme's foreground). */
  fg: string;
  background: Background;
  style: BackgroundStyle;
  /** What shows through a translucent layer (the scheme's background). */
  base?: string;
  /** Called with the dim (0–90) that reaches 4.5:1. */
  onRaiseDim: (dim: number) => void;
}

/** Shows a warning with a "Raise dim" button when text contrast is under 4.5:1; nothing otherwise. */
export function ContrastWarning({ fg, background, style, base, onRaiseDim }: ContrastWarningProps) {
  const [, setSampled] = useState(0);
  const bgKey = JSON.stringify(background);
  useEffect(() => {
    let gone = false;
    void sampleBackground(background).then((s) => {
      if (s && !gone) setSampled((n) => n + 1);
    });
    return () => {
      gone = true;
    };
  }, [bgKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Cheap enough to recompute each render; picks up the sample once it lands.
  const live = contrastWarning(fg, background, style, base);
  if (!live || live.ok) return null;
  const canRaise = live.suggestedDim > style.dim;
  return (
    <div className="contrast-warning" role="status">
      <span>
        Text contrast is about {live.ratio.toFixed(1)}:1 (aim for 4.5:1).
        {!canRaise && " Pick a lighter text colour or a darker background."}
      </span>
      {canRaise && (
        <button type="button" onClick={() => onRaiseDim(live.suggestedDim)}>
          Raise dim to {live.suggestedDim}%
        </button>
      )}
    </div>
  );
}
