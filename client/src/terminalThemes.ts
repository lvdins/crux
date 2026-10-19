// Terminal colour schemes: the built-ins, importers for iTerm2 / Windows
// Terminal files, and the mapping onto xterm's theme.
import type { ITheme } from "@xterm/xterm";
import type { Appearance, TermScheme } from "./appearance";

type Ansi = Omit<TermScheme, "name" | "foreground" | "background" | "cursor" | "selectionBackground">;

// Solarized shares one ANSI palette between its dark and light variants.
const SOLARIZED: Ansi = {
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

/** Built-in schemes. "crux-dark" is the look Crux always had. */
export const SCHEMES: Record<string, TermScheme> = {
  "crux-dark": {
    name: "Crux Dark",
    background: "#1b1c20",
    foreground: "#e6e6e6",
    cursor: "#3ecf8e",
    selectionBackground: "#3a4a42",
    black: "#2a2b30",
    red: "#e06c75",
    green: "#3ecf8e",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#d4d4d4",
    brightBlack: "#5c6370",
    brightRed: "#ef7f88",
    brightGreen: "#5fe0a6",
    brightYellow: "#f0d08e",
    brightBlue: "#7cc0f5",
    brightMagenta: "#d595e8",
    brightCyan: "#6fcad5",
    brightWhite: "#f5f5f5",
  },
  "solarized-dark": {
    name: "Solarized Dark",
    background: "#002b36",
    foreground: "#839496",
    cursor: "#93a1a1",
    selectionBackground: "#073642",
    ...SOLARIZED,
  },
  "solarized-light": {
    name: "Solarized Light",
    background: "#fdf6e3",
    foreground: "#657b83",
    cursor: "#586e75",
    selectionBackground: "#eee8d5",
    ...SOLARIZED,
  },
  dracula: {
    name: "Dracula",
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  nord: {
    name: "Nord",
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    selectionBackground: "#434c5e",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  "one-dark": {
    name: "One Dark",
    background: "#282c34",
    foreground: "#abb2bf",
    cursor: "#528bff",
    selectionBackground: "#3e4451",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  gruvbox: {
    name: "Gruvbox Dark",
    background: "#282828",
    foreground: "#ebdbb2",
    cursor: "#ebdbb2",
    selectionBackground: "#504945",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  // The two loud ones match the Cyberpunk / Unicorn app themes.
  "cyberpunk-neon": {
    name: "Cyberpunk Neon",
    background: "#0d0221",
    foreground: "#e8e3ff",
    cursor: "#ff2a6d",
    selectionBackground: "#3d1a5c",
    black: "#1a103d",
    red: "#ff2a6d",
    green: "#05ffa1",
    yellow: "#f9f871",
    blue: "#01cdfe",
    magenta: "#ff00e5",
    cyan: "#00fff0",
    white: "#d1c7f2",
    brightBlack: "#5a4a8a",
    brightRed: "#ff5c8d",
    brightGreen: "#5cffbd",
    brightYellow: "#fffb9c",
    brightBlue: "#5ce1ff",
    brightMagenta: "#ff5cf0",
    brightCyan: "#7dfff8",
    brightWhite: "#ffffff",
  },
  "unicorn-rainbow": {
    name: "Unicorn Rainbow",
    background: "#241b35",
    foreground: "#fdf0ff",
    cursor: "#ff9ff3",
    selectionBackground: "#4a3866",
    black: "#33284a",
    red: "#ff8fab",
    green: "#9ef0b8",
    yellow: "#ffe08a",
    blue: "#8ec5ff",
    magenta: "#d7a6ff",
    cyan: "#8ff0eb",
    white: "#efe4ff",
    brightBlack: "#7a6a9a",
    brightRed: "#ffb3c6",
    brightGreen: "#c2ffd3",
    brightYellow: "#fff0b3",
    brightBlue: "#b8dbff",
    brightMagenta: "#ebcbff",
    brightCyan: "#b8fffa",
    brightWhite: "#ffffff",
  },
};

export const DEFAULT_SCHEME = "crux-dark";
export const CUSTOM_PREFIX = "custom:";

/** A built-in id, or "custom:<name>" from the imported schemes; unknown → Crux Dark. */
export function getScheme(id: string, a: Appearance): TermScheme {
  if (id.startsWith(CUSTOM_PREFIX)) {
    const custom = a.customSchemes[id.slice(CUSTOM_PREFIX.length)];
    if (custom) return custom;
  }
  return SCHEMES[id] ?? SCHEMES[DEFAULT_SCHEME];
}

/** Every scheme a picker should offer: built-ins, then imported ones. */
export function listSchemes(a: Appearance): { id: string; scheme: TermScheme }[] {
  return [
    ...Object.entries(SCHEMES).map(([id, scheme]) => ({ id, scheme })),
    ...Object.entries(a.customSchemes).map(([name, scheme]) => ({ id: CUSTOM_PREFIX + name, scheme })),
  ];
}

export function toXtermTheme(s: TermScheme): ITheme {
  return {
    background: s.background,
    foreground: s.foreground,
    cursor: s.cursor,
    cursorAccent: s.background,
    selectionBackground: s.selectionBackground,
    black: s.black,
    red: s.red,
    green: s.green,
    yellow: s.yellow,
    blue: s.blue,
    magenta: s.magenta,
    cyan: s.cyan,
    white: s.white,
    brightBlack: s.brightBlack,
    brightRed: s.brightRed,
    brightGreen: s.brightGreen,
    brightYellow: s.brightYellow,
    brightBlue: s.brightBlue,
    brightMagenta: s.brightMagenta,
    brightCyan: s.brightCyan,
    brightWhite: s.brightWhite,
  };
}

// ---------------------------------------------------------------- importers

const ANSI_KEYS: (keyof Ansi)[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");

/** "#abc" / "#aabbcc" / "#aabbccdd" → lower-case "#aabbcc[dd]"; anything else → undefined. */
function normHex(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v.trim());
  if (!m) return undefined;
  const h = m[1].toLowerCase();
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h);
}

/** Fill the optional colours and check the 16 ANSI ones are all there. */
function finish(name: string, c: Partial<Record<keyof TermScheme, string>>, source: string): TermScheme {
  const missing = ["foreground", "background", ...ANSI_KEYS].filter((k) => !c[k as keyof TermScheme]);
  if (missing.length) throw new Error(`This ${source} file is missing colours: ${missing.join(", ")}.`);
  return {
    name: name.trim() || "Imported",
    foreground: c.foreground!,
    background: c.background!,
    cursor: c.cursor ?? c.foreground!,
    selectionBackground: c.selectionBackground ?? c.brightBlack!,
    ...(Object.fromEntries(ANSI_KEYS.map((k) => [k, c[k]!])) as Ansi),
  };
}

/** iTerm2 .itermcolors (an XML plist of colour dicts, components 0–1). */
export function parseItermColors(xml: string, name = "Imported"): TermScheme {
  let doc: Document | undefined;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    /* reported below */
  }
  // Plain DOM calls only (no querySelector / .children), so this also runs under xmldom in tests.
  const elems = (n: Node) => [...n.childNodes].filter((c): c is Element => c.nodeType === 1);
  const plist = doc?.documentElement;
  const root = plist?.nodeName === "plist" ? elems(plist).find((e) => e.nodeName === "dict") : undefined;
  if (!root || doc!.getElementsByTagName("parsererror").length) throw new Error("Not a valid .itermcolors file (couldn't read the XML plist).");
  const colors: Record<string, string> = {};
  const kids = elems(root);
  for (let i = 0; i < kids.length - 1; i++) {
    if (kids[i].nodeName !== "key" || kids[i + 1].nodeName !== "dict") continue;
    const comp: Record<string, number> = {};
    const parts = elems(kids[i + 1]);
    for (let j = 0; j < parts.length - 1; j++) {
      if (parts[j].nodeName === "key") comp[parts[j].textContent?.trim() ?? ""] = Number(parts[j + 1].textContent);
    }
    const [r, g, b] = ["Red", "Green", "Blue"].map((ch) => comp[`${ch} Component`]);
    if ([r, g, b].every((v) => Number.isFinite(v))) colors[kids[i].textContent?.trim() ?? ""] = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const c: Partial<Record<keyof TermScheme, string>> = {
    foreground: colors["Foreground Color"],
    background: colors["Background Color"],
    cursor: colors["Cursor Color"],
    selectionBackground: colors["Selection Color"],
  };
  ANSI_KEYS.forEach((k, i) => (c[k] = colors[`Ansi ${i} Color`]));
  return finish(name, c, ".itermcolors");
}

/** Drop // and /* *\/ comments and trailing commas (Windows Terminal's settings.json is JSONC). */
function stripJsonc(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
      out += src.slice(start, i + 1);
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Windows Terminal: one scheme object, or a whole settings.json with a
 * "schemes" array (the scheme called `pick`, else the first).
 */
export function parseWindowsTerminal(json: string, pick?: string): TermScheme {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonc(json.replace(/^﻿/, "")));
  } catch {
    throw new Error("Not a valid Windows Terminal file (couldn't read the JSON).");
  }
  let s = data as Record<string, unknown> | undefined;
  const list = Array.isArray(data) ? data : (data as { schemes?: unknown })?.schemes;
  if (Array.isArray(list)) {
    if (!list.length) throw new Error('This Windows Terminal file has no colour schemes ("schemes" is empty).');
    s = (pick && list.find((x) => x?.name === pick)) || list[0];
  }
  if (!s || typeof s !== "object") throw new Error("No Windows Terminal colour scheme found in this file.");
  const get = (k: string) => normHex(s![k]);
  const c: Partial<Record<keyof TermScheme, string>> = {
    foreground: get("foreground"),
    background: get("background"),
    cursor: get("cursorColor"),
    selectionBackground: get("selectionBackground"),
  };
  // Windows Terminal calls magenta "purple".
  for (const k of ANSI_KEYS) c[k] = get(k === "magenta" ? "purple" : k === "brightMagenta" ? "brightPurple" : k);
  return finish(typeof s.name === "string" ? s.name : "Imported", c, "Windows Terminal");
}

/** Read a dropped/picked scheme file: .itermcolors, Windows Terminal JSON, or a Crux theme file. */
export async function importScheme(file: File): Promise<TermScheme> {
  const text = await file.text();
  const base = file.name.replace(/\.[^.]+$/, "");
  const ext = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const head = text.trimStart().slice(0, 200);
  if (ext === "itermcolors" || head.startsWith("<?xml") || head.startsWith("<plist") || head.startsWith("<!DOCTYPE plist")) {
    return parseItermColors(text, base);
  }
  if (ext === "json" || head.startsWith("{") || head.startsWith("[")) {
    // A Crux theme file carries its scheme inside.
    try {
      const t = JSON.parse(text) as { crux?: string; scheme?: TermScheme };
      if (t?.crux === "theme") {
        if (!t.scheme) throw new Error("This Crux theme file has no terminal scheme in it.");
        return finish(t.scheme.name ?? base, t.scheme, "Crux theme");
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("This Crux")) throw e;
      /* not plain JSON: let the JSONC reader try */
    }
    const s = parseWindowsTerminal(text);
    return s.name === "Imported" ? { ...s, name: base } : s;
  }
  throw new Error(`Can't read "${file.name}": use an iTerm2 .itermcolors file or a Windows Terminal .json scheme.`);
}
