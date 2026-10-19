// Shared Appearance contract. Every worker adds this file VERBATIM
// (client/src/appearance.ts). Do not edit it on your branch; put extra types
// in your own module. Ask the lead if the contract needs to change.

export type AppTheme = "crux-dark" | "crux-light" | "system" | "cyberpunk" | "unicorn";
export type ChatKind = "claude" | "codex" | "shell";
export type CursorStyle = "block" | "bar" | "underline";
export type BgFit = "cover" | "contain" | "tile" | "center";

export interface TermFont {
  family?: string;       // CSS font-family; undefined → today's FONT
  size?: number;         // 10–24; undefined → 12.5
  lineHeight?: number;   // 1.0–2.0; undefined → xterm default
  ligatures?: boolean;
  cursorStyle?: CursorStyle;
  cursorBlink?: boolean; // undefined → true (today)
}

export type Background =
  | { kind: "none" }
  | { kind: "solid"; color: string }
  | { kind: "gradient"; from: string; to: string; angle: number }
  | { kind: "image" | "gif" | "video"; asset: string } // asset = file name in ~/.crux/themes/assets
  | { kind: "wild"; id: WildId };

export interface BackgroundStyle {
  fit: BgFit;
  opacity: number; // 0–100
  blur: number;    // 0–20 px
  dim: number;     // 0–90, extra dark overlay for contrast
}

export type WildId =
  | "neon-sunset" | "glitch-overdrive" | "matrix-rainbow" | "hologram-unicorn"
  | "night-market" | "laser-grid" | "pink-dream" | "neon-pink";

export interface Playlist {
  ids: WildId[];
  every: 1 | 5 | 15 | 60 | "session"; // minutes, or a new one per session
  order: "shuffle" | "in-order";
}

/** Look of one terminal layer: any field missing falls through to the next level. */
export interface TermLook {
  scheme?: string; // terminal scheme id (built-in id or "custom:<name>")
  background?: Background;
  backgroundStyle?: BackgroundStyle;
}

export interface Appearance {
  theme: AppTheme;
  accent?: string;           // hex; undefined → theme's own accent
  terminalScheme: string;    // app default scheme id
  font: TermFont;
  background: Background;
  backgroundStyle: BackgroundStyle;
  playlist?: Playlist;
  reactToState: boolean;     // wild backgrounds react to working/attention
  reduceMotion: boolean;     // also honoured when the OS asks for it
  perWorkspace: Record<string, TermLook>; // key = repo key
  perKind: Partial<Record<ChatKind, TermLook>>;
  customSchemes: Record<string, TermScheme>; // imported schemes, key = name
}

/** xterm ITheme-compatible colour set. */
export interface TermScheme {
  name: string;
  foreground: string; background: string; cursor: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

/** A shareable theme file (~/.crux/themes/<name>.json). */
export interface ThemeFile {
  crux: "theme";
  version: 1;
  name: string;
  appearance: Partial<Omit<Appearance, "perWorkspace" | "perKind">>;
  scheme?: TermScheme; // embedded so the file is self-contained
}

/** With no appearance saved, Crux looks exactly like today. */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: "crux-dark",
  terminalScheme: "crux-dark",
  font: {},
  background: { kind: "none" },
  backgroundStyle: { fit: "cover", opacity: 100, blur: 0, dim: 0 },
  reactToState: true,
  reduceMotion: false,
  perWorkspace: {},
  perKind: {},
  customSchemes: {},
};

/** Fill gaps from the defaults (old/partial settings). */
export function withDefaults(a?: Partial<Appearance> | null): Appearance {
  return {
    ...DEFAULT_APPEARANCE,
    ...(a ?? {}),
    font: { ...(a?.font ?? {}) },
    backgroundStyle: { ...DEFAULT_APPEARANCE.backgroundStyle, ...(a?.backgroundStyle ?? {}) },
    perWorkspace: { ...(a?.perWorkspace ?? {}) },
    perKind: { ...(a?.perKind ?? {}) },
    customSchemes: { ...(a?.customSchemes ?? {}) },
  };
}

/**
 * Resolve one terminal's look. Order: session > workspace > kind > app default.
 * `session` is TermTab.look.
 */
export function resolveLook(a: Appearance, ctx: { session?: TermLook; repo?: string; kind?: ChatKind }): Required<TermLook> {
  const layers = [ctx.session, ctx.repo ? a.perWorkspace[ctx.repo] : undefined, ctx.kind ? a.perKind[ctx.kind] : undefined];
  const pick = <K extends keyof TermLook>(k: K): TermLook[K] | undefined => layers.find((l) => l?.[k] !== undefined)?.[k];
  return {
    scheme: pick("scheme") ?? a.terminalScheme,
    background: pick("background") ?? a.background,
    backgroundStyle: pick("backgroundStyle") ?? a.backgroundStyle,
  };
}

/** Client-side event: fired on window whenever appearance changes (settings saved or live preview). */
export const APPEARANCE_EVENT = "crux:appearance";
export type AppearanceEventDetail = Appearance;
export function emitAppearance(a: Appearance): void {
  window.dispatchEvent(new CustomEvent<AppearanceEventDetail>(APPEARANCE_EVENT, { detail: a }));
}

/** Agent state per terminal, published by App.tsx for reactive backgrounds. */
export type TermState = "idle" | "working" | "attention" | "finished";
export const TERM_STATE_EVENT = "crux:term-state";
export interface TermStateDetail { id: string; state: TermState }

/** localStorage flag: set when ⌥ was held at launch → ignore custom appearance this run. */
export const SAFE_MODE_KEY = "crux.appearance.safe";
