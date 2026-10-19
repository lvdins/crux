// App theme: puts the saved Appearance on <html> (data-theme, accent,
// reduce motion, scan lines) for every window, and keeps it live as
// Settings or another window changes it. The colours live in themes.css.
import { APPEARANCE_EVENT, DEFAULT_APPEARANCE, SAFE_MODE_KEY, withDefaults, type AppTheme, type Appearance } from "./appearance";

export const APPEARANCE_KEY = "crux.appearance";
type ResolvedTheme = Exclude<AppTheme, "system">;

const LIGHT: ReadonlySet<ResolvedTheme> = new Set(["crux-light", "unicorn"]);
const inTauri = "__TAURI_INTERNALS__" in window;
const auxWindow = !!(window as { __CRUX_QUICK__?: boolean; __CRUX_TRAY__?: boolean }).__CRUX_QUICK__ ||
  !!(window as { __CRUX_TRAY__?: boolean }).__CRUX_TRAY__;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

let current: Appearance = DEFAULT_APPEARANCE;
let started = false;

/** "system" follows the OS live; everything else is itself. */
export function resolveTheme(theme: AppTheme): ResolvedTheme {
  if (theme !== "system") return theme;
  return darkQuery.matches ? "crux-dark" : "crux-light";
}

export function isLightTheme(theme: AppTheme): boolean {
  return LIGHT.has(resolveTheme(theme));
}

export function applyAppTheme(a: Appearance): void {
  current = a;
  const root = document.documentElement;
  const theme = resolveTheme(a.theme);
  // Crux Dark is the stylesheet's own look: no attribute at all.
  if (theme === "crux-dark") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);

  const accent = a.accent?.trim();
  const rgb = accent ? toRgb(accent) : null;
  if (accent && rgb) {
    const toward = LIGHT.has(theme) ? "black" : "white";
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-rgb", rgb);
    root.style.setProperty("--accent-ink", `color-mix(in srgb, ${accent} 80%, ${toward})`);
    root.style.setProperty("--accent-soft", `rgba(${rgb}, 0.16)`);
  } else {
    for (const p of ["--accent", "--accent-rgb", "--accent-ink", "--accent-soft"]) root.style.removeProperty(p);
  }

  root.toggleAttribute("data-reduce-motion", a.reduceMotion || motionQuery.matches);
  root.toggleAttribute("data-scanlines", theme === "cyberpunk");
  // Native window chrome: light for an explicitly light theme. "System"
  // leaves it to the OS, or the forced appearance would hide OS changes.
  setWindowTheme(a.theme !== "system" && LIGHT.has(theme) ? "light" : null);
}

/** "r, g, b" of any CSS colour (styles.css tints with rgba(var(--accent-rgb), a)); null if invalid. */
function toRgb(color: string): string | null {
  if (!CSS.supports("color", color)) return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = color; // normalised to #rrggbb (or rgba(...) when translucent)
  const v = String(ctx.fillStyle);
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`;
  }
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return m ? `${m[1]}, ${m[2]}, ${m[3]}` : null;
}

let windowTheme: "light" | "dark" | null = null; // null = follow the OS (today)
function setWindowTheme(t: "light" | "dark" | null): void {
  if (!inTauri || t === windowTheme) return;
  windowTheme = t;
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(t))
    .catch(() => {});
}

function stored(): Appearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    return withDefaults(raw ? (JSON.parse(raw) as Partial<Appearance>) : null);
  } catch {
    return withDefaults(null);
  }
}

/** True when ⌥ was held at launch: the custom look is off for this run. */
export function isSafeMode(): boolean {
  try {
    return localStorage.getItem(SAFE_MODE_KEY) === "1" || sessionStorage.getItem(SAFE_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

function setSafeFlag(on: boolean): void {
  try {
    // localStorage so Quick Ask / the menu bar panel see it too; the main
    // window rewrites it on every launch, so it never outlives the run.
    if (on) {
      localStorage.setItem(SAFE_MODE_KEY, "1");
      sessionStorage.setItem(SAFE_MODE_KEY, "1");
    } else {
      localStorage.removeItem(SAFE_MODE_KEY);
      sessionStorage.removeItem(SAFE_MODE_KEY);
    }
  } catch {
    /* storage blocked: safe mode just lasts as long as this page */
  }
}

function enterSafeMode(): void {
  if (isSafeMode()) return;
  setSafeFlag(true);
  applyAppTheme(DEFAULT_APPEARANCE);
}

/** Leave safe mode and put the saved appearance back. */
export function exitSafeMode(): void {
  setSafeFlag(false);
  applyAppTheme(stored());
}

/** Apply the saved look now (before first render) and keep it in sync. */
export function initTheme(): void {
  if (started) return;
  started = true;

  // A new run of the main window starts out of safe mode; ⌥ decides below.
  if (!auxWindow) setSafeFlag(false);
  applyAppTheme(isSafeMode() ? DEFAULT_APPEARANCE : stored());

  if (!auxWindow) {
    if (inTauri) {
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<boolean>("launch_option_held"))
        .then((held) => held && enterSafeMode())
        .catch(() => {});
    } else {
      // Browser dev: ⌥ pressed in the first moments counts as held at launch.
      const onKey = (e: KeyboardEvent) => e.key === "Alt" && enterSafeMode();
      window.addEventListener("keydown", onKey);
      setTimeout(() => window.removeEventListener("keydown", onKey), 1500);
    }
  }

  // Settings (same window): saved or live-previewed. Ignored in safe mode.
  window.addEventListener(APPEARANCE_EVENT, (e) => {
    if (isSafeMode()) return;
    const detail = (e as CustomEvent<Appearance>).detail;
    if (detail) applyAppTheme(withDefaults(detail));
  });
  // Other windows (Quick Ask, menu bar panel) follow the main window's saves.
  window.addEventListener("storage", (e) => {
    if (e.key === APPEARANCE_KEY && !isSafeMode()) applyAppTheme(stored());
    else if (e.key === SAFE_MODE_KEY) applyAppTheme(isSafeMode() ? DEFAULT_APPEARANCE : stored());
  });
  // "System" and the OS reduce-motion switch follow the OS live.
  darkQuery.addEventListener("change", () => current.theme === "system" && applyAppTheme(current));
  motionQuery.addEventListener("change", () => applyAppTheme(current));
}
