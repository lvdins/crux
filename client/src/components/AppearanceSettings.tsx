import { useEffect, useRef, useState } from "react";
import { api } from "../net";
import {
  DEFAULT_APPEARANCE,
  emitAppearance,
  withDefaults,
  type Appearance,
  type AppTheme,
  type Background,
  type BackgroundStyle,
  type BgFit,
  type ChatKind,
  type CursorStyle,
  type Playlist,
  type TermLook,
  type ThemeFile,
  type WildId,
} from "../appearance";
import { SCHEMES, importScheme } from "../terminalThemes";
import type { Settings } from "../types";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const APP_THEMES: [AppTheme, string][] = [
  ["crux-dark", "Crux Dark"],
  ["crux-light", "Crux Light"],
  ["system", "System"],
  ["cyberpunk", "Cyberpunk"],
  ["unicorn", "Unicorn"],
];
const FONTS = ["SF Mono", "Menlo", "Monaco", "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", "IBM Plex Mono", "Hack", "Consolas"];
const CURSORS: [CursorStyle, string][] = [["block", "Block"], ["bar", "Bar"], ["underline", "Underline"]];
const BG_KINDS: [Background["kind"], string][] = [
  ["none", "None"],
  ["solid", "Solid"],
  ["gradient", "Gradient"],
  ["image", "Image"],
  ["gif", "GIF"],
  ["video", "Video"],
  ["wild", "Wild"],
];
const WILD: [WildId, string][] = [
  ["neon-sunset", "Neon Sunset"],
  ["glitch-overdrive", "Glitch Overdrive"],
  ["matrix-rainbow", "Matrix Rainbow"],
  ["hologram-unicorn", "Hologram Unicorn"],
  ["night-market", "Night Market"],
  ["laser-grid", "Laser Grid"],
  ["pink-dream", "Pink Dream"],
  ["neon-pink", "Neon Pink"],
];
const EVERY: [Playlist["every"], string][] = [[1, "Every minute"], [5, "Every 5 min"], [15, "Every 15 min"], [60, "Every hour"], ["session", "Each session"]];
const FITS: [BgFit, string][] = [["cover", "Cover"], ["contain", "Contain"], ["tile", "Tile"], ["center", "Center"]];
const KINDS: [ChatKind, string][] = [["claude", "Claude"], ["codex", "Codex"], ["shell", "Terminal"]];
const ACCEPT: Record<"image" | "gif" | "video", string> = {
  image: ".png,.jpg,.jpeg,.webp",
  gif: ".gif",
  video: ".mp4,.webm",
};

/** A new background of `kind`, reusing what `from` already has where it fits. */
function backgroundOf(kind: Background["kind"], from: Background): Background {
  if (kind === from.kind) return from;
  switch (kind) {
    case "none":
      return { kind };
    case "solid":
      return { kind, color: "#101418" };
    case "gradient":
      return { kind, from: "#1b1f3a", to: "#3a1b38", angle: 135 };
    case "wild":
      return { kind, id: "neon-sunset" };
    default:
      return { kind, asset: "" };
  }
}

/** Scheme options: built-ins (worker C's list), imported ones, and whatever is selected now. */
function schemeOptions(look: Appearance, extra?: string): [string, string][] {
  const opts: [string, string][] = Object.entries(SCHEMES).map(([id, s]) => [id, s.name]);
  if (!opts.some(([id]) => id === "crux-dark")) opts.unshift(["crux-dark", "Crux Dark"]);
  for (const name of Object.keys(look.customSchemes)) opts.push([`custom:${name}`, `${name} (imported)`]);
  for (const id of [look.terminalScheme, extra]) if (id && !opts.some(([o]) => o === id)) opts.push([id, id]);
  return opts;
}

async function uploadAsset(file: File): Promise<string> {
  if (file.size > 20 * 1024 * 1024) throw new Error("Files up to 20 MB");
  const r = await api(`/api/themes/assets?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const out = (await r.json().catch(() => ({}))) as { asset?: string; error?: string };
  if (!r.ok || !out.asset) throw new Error(out.error || `Upload failed (${r.status})`);
  return out.asset;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row static">
      <span className="settings-text">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function Slider({ value, min, max, step = 1, unit = "", onChange }: { value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <span className="appearance-slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>
        {value}
        {unit}
      </output>
    </span>
  );
}

/** Kind + its values (colours, file, Wild pack). Used for the app default and the overrides. */
function BackgroundFields({ value, onChange, onError }: { value: Background; onChange: (b: Background) => void; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = async (file: File | undefined) => {
    if (!file || (value.kind !== "image" && value.kind !== "gif" && value.kind !== "video")) return;
    setBusy(true);
    try {
      onChange({ kind: value.kind, asset: await uploadAsset(file) });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="appearance-inline">
      <select className="settings-input appearance-select" value={value.kind} onChange={(e) => onChange(backgroundOf(e.target.value as Background["kind"], value))}>
        {BG_KINDS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      {value.kind === "solid" && <input type="color" value={value.color} onChange={(e) => onChange({ ...value, color: e.target.value })} />}
      {value.kind === "gradient" && (
        <>
          <input type="color" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          <input type="color" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
          <input
            className="settings-input appearance-num"
            type="number"
            min={0}
            max={360}
            value={value.angle}
            title="Angle (degrees)"
            onChange={(e) => onChange({ ...value, angle: Math.min(360, Math.max(0, Number(e.target.value) || 0)) })}
          />
        </>
      )}
      {value.kind === "wild" && (
        <select className="settings-input appearance-select" value={value.id} onChange={(e) => onChange({ ...value, id: e.target.value as WildId })}>
          {WILD.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      )}
      {(value.kind === "image" || value.kind === "gif" || value.kind === "video") && (
        <>
          <input ref={fileRef} type="file" hidden accept={ACCEPT[value.kind]} onChange={(e) => void pick(e.target.files?.[0]).then(() => (e.target.value = ""))} />
          <button className="settings-btn-sm" disabled={busy} onClick={() => fileRef.current?.click()} title={value.asset || undefined}>
            {busy ? "Uploading…" : value.asset ? "Change file…" : "Choose file…"}
          </button>
        </>
      )}
    </span>
  );
}

/** One override row: scheme + background, each "Inherit" when unset. */
function LookOverride({
  label,
  look,
  value,
  onChange,
  onError,
}: {
  label: string;
  look: Appearance;
  value: TermLook | undefined;
  onChange: (v: TermLook | undefined) => void;
  onError: (msg: string) => void;
}) {
  const set = (patch: Partial<TermLook>) => {
    const next: TermLook = { ...value, ...patch };
    for (const k of Object.keys(next) as (keyof TermLook)[]) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="settings-row static appearance-override">
      <span className="settings-text">
        <b>{label}</b>
      </span>
      <span className="appearance-inline">
        <select className="settings-input appearance-select" value={value?.scheme ?? ""} onChange={(e) => set({ scheme: e.target.value || undefined })}>
          <option value="">Scheme: default</option>
          {schemeOptions(look, value?.scheme).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        {value?.background ? (
          <>
            <BackgroundFields value={value.background} onChange={(b) => set({ background: b })} onError={onError} />
            <button className="settings-btn-sm" title="Use the default background" onClick={() => set({ background: undefined })}>
              ×
            </button>
          </>
        ) : (
          <button className="settings-btn-sm" onClick={() => set({ background: look.background })}>
            Own background
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * Settings → Appearance. Every change previews right away (emitAppearance)
 * and is saved shortly after; leaving the page saves what's pending.
 */
export default function AppearanceSettings({ settings, onChange }: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const [look, setLook] = useState<Appearance>(() => withDefaults(settings.appearance));
  // The look when the page opened, for "Undo changes".
  const opened = useRef(look);
  const pending = useRef<Appearance | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [error, setError] = useState("");
  const [repos, setRepos] = useState<Record<string, { label: string }>>({});
  const [themes, setThemes] = useState<(ThemeFile & { file: string })[]>([]);
  const [themeName, setThemeName] = useState("");
  const [notice, setNotice] = useState("");
  const schemeRef = useRef<HTMLInputElement>(null);
  const themeRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const flush = () => {
    clearTimeout(timer.current);
    if (pending.current) onChangeRef.current({ appearance: pending.current });
    pending.current = null;
  };
  const update = (next: Appearance) => {
    setLook(next);
    emitAppearance(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
  const patch = (p: Partial<Appearance>) => update({ ...look, ...p });
  // Closing Settings (or switching page) saves what's still waiting.
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadThemes = () =>
    void api("/api/themes")
      .then((r) => r.json())
      .then(setThemes)
      .catch(() => undefined);
  useEffect(() => {
    loadThemes();
    void api("/api/config")
      .then((r) => r.json())
      .then((c: { repos?: Record<string, { label: string }> }) => setRepos(c.repos ?? {}))
      .catch(() => undefined);
  }, []);

  const fail = (msg: string) => {
    setError(msg);
    setTimeout(() => setError((e) => (e === msg ? "" : e)), 6000);
  };

  const onImportScheme = async (file: File | undefined) => {
    if (!file) return;
    try {
      const scheme = await importScheme(file);
      patch({ customSchemes: { ...look.customSchemes, [scheme.name]: scheme }, terminalScheme: `custom:${scheme.name}` });
    } catch (err) {
      fail(`Couldn't import that scheme: ${(err as Error).message}`);
    }
  };

  const saveTheme = async () => {
    const name = themeName.trim();
    if (!name) return;
    const { perWorkspace: _w, perKind: _k, customSchemes: _c, ...rest } = look;
    const custom = look.terminalScheme.startsWith("custom:") ? look.customSchemes[look.terminalScheme.slice(7)] : undefined;
    const file: ThemeFile = { crux: "theme", version: 1, name, appearance: rest, ...(custom ? { scheme: custom } : {}) };
    const r = await api("/api/themes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(file) });
    if (!r.ok) return fail(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save the theme");
    setThemeName("");
    loadThemes();
  };

  const applyTheme = (t: ThemeFile) => {
    const next = withDefaults({ ...look, ...t.appearance, perWorkspace: look.perWorkspace, perKind: look.perKind, customSchemes: look.customSchemes });
    if (t.scheme) {
      const key = next.terminalScheme.startsWith("custom:") ? next.terminalScheme.slice(7) : t.scheme.name;
      next.customSchemes = { ...next.customSchemes, [key]: t.scheme };
      next.terminalScheme = `custom:${key}`;
    }
    update(next);
  };

  const exportTheme = async (t: ThemeFile & { file: string }) => {
    const name = encodeURIComponent(t.file);
    if (IN_TAURI) {
      const r = await api(`/api/themes/${name}/export?save=1`);
      const out = (await r.json().catch(() => ({}))) as { path?: string; error?: string };
      return out.path ? setNotice(`Saved to ${out.path}`) : fail(out.error ?? "Couldn't export");
    }
    const r = await api(`/api/themes/${name}/export`);
    if (!r.ok) return fail("Couldn't export");
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: `${t.file}.crux-theme.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const deleteTheme = async (t: ThemeFile & { file: string }) => {
    await api(`/api/themes/${encodeURIComponent(t.file)}`, { method: "DELETE" });
    loadThemes();
  };

  const importTheme = async (file: File | undefined) => {
    if (!file) return;
    try {
      const body = await file.text();
      JSON.parse(body);
      const r = await api("/api/themes/import", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const out = (await r.json().catch(() => ({}))) as ThemeFile & { error?: string };
      if (!r.ok) throw new Error(out.error ?? `status ${r.status}`);
      setNotice(`Imported “${out.name}”. Apply it from the list.`);
      loadThemes();
    } catch (err) {
      fail(`Couldn't import that file: ${(err as Error).message}`);
    }
  };

  const bgStyle = (p: Partial<BackgroundStyle>) => patch({ backgroundStyle: { ...look.backgroundStyle, ...p } });
  const playlist: Playlist = look.playlist ?? { ids: [], every: 15, order: "shuffle" };
  const font = look.font;

  return (
    <>
      {error && <p className="settings-note warn first">{error}</p>}

      <div className="settings-section">App</div>
      <div className="settings-choice">
        {APP_THEMES.map(([id, label]) => (
          <button key={id} className={look.theme === id ? "on" : ""} onClick={() => patch({ theme: id })}>
            {label}
          </button>
        ))}
      </div>
      <div className="settings-list appearance-gap">
        <Row label="Accent colour" hint={look.accent ? look.accent : "The theme's own accent."}>
          <span className="appearance-inline">
            <input type="color" value={look.accent ?? "#7c5cff"} onChange={(e) => patch({ accent: e.target.value })} />
            <button className="settings-btn-sm" disabled={!look.accent} onClick={() => patch({ accent: undefined })}>
              Theme default
            </button>
          </span>
        </Row>
      </div>

      <div className="settings-section">Terminal</div>
      <div className="settings-list">
        <Row label="Colour scheme">
          <span className="appearance-inline">
            <select className="settings-input appearance-select" value={look.terminalScheme} onChange={(e) => patch({ terminalScheme: e.target.value })}>
              {schemeOptions(look).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <input ref={schemeRef} type="file" hidden accept=".itermcolors,.json" onChange={(e) => void onImportScheme(e.target.files?.[0]).then(() => (e.target.value = ""))} />
            <button className="settings-btn-sm" onClick={() => schemeRef.current?.click()}>
              Import…
            </button>
          </span>
        </Row>
        <Row label="Font" hint="Blank: Crux's default.">
          <input
            className="settings-input appearance-font"
            list="appearance-fonts"
            placeholder="Default"
            value={font.family ?? ""}
            onChange={(e) => patch({ font: { ...font, family: e.target.value || undefined } })}
          />
          <datalist id="appearance-fonts">
            {FONTS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Row>
        <Row label="Size">
          <Slider value={font.size ?? 12.5} min={10} max={24} step={0.5} unit="px" onChange={(size) => patch({ font: { ...font, size } })} />
        </Row>
        <Row label="Line height">
          <Slider value={font.lineHeight ?? 1} min={1} max={2} step={0.05} onChange={(lineHeight) => patch({ font: { ...font, lineHeight } })} />
        </Row>
        <label className="settings-row">
          <span className="settings-text">
            <b>Ligatures</b>
            <span>Join =&gt;, != and friends, when the font has them.</span>
          </span>
          <input type="checkbox" className="settings-switch" checked={!!font.ligatures} onChange={(e) => patch({ font: { ...font, ligatures: e.target.checked } })} />
        </label>
        <Row label="Cursor">
          <span className="appearance-inline">
            <select
              className="settings-input appearance-select"
              value={font.cursorStyle ?? "block"}
              onChange={(e) => patch({ font: { ...font, cursorStyle: e.target.value as CursorStyle } })}
            >
              {CURSORS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <label className="appearance-check">
              <input type="checkbox" checked={font.cursorBlink ?? true} onChange={(e) => patch({ font: { ...font, cursorBlink: e.target.checked } })} />
              Blink
            </label>
          </span>
        </Row>
      </div>

      <div className="settings-section">Background</div>
      <div className="settings-list">
        <Row label="Background">
          <BackgroundFields value={look.background} onChange={(background) => patch({ background })} onError={fail} />
        </Row>
        {look.background.kind === "wild" && (
          <Row label="Playlist" hint={playlist.ids.length ? `${playlist.ids.length} in rotation` : "Off: always the one above."}>
            <span className="appearance-inline wrap">
              {WILD.map(([id, label]) => (
                <label key={id} className="appearance-check">
                  <input
                    type="checkbox"
                    checked={playlist.ids.includes(id)}
                    onChange={(e) => {
                      const ids = e.target.checked ? [...playlist.ids, id] : playlist.ids.filter((x) => x !== id);
                      patch({ playlist: ids.length ? { ...playlist, ids } : undefined });
                    }}
                  />
                  {label}
                </label>
              ))}
              <select
                className="settings-input appearance-select"
                value={String(playlist.every)}
                onChange={(e) => patch({ playlist: { ...playlist, every: (e.target.value === "session" ? "session" : Number(e.target.value)) as Playlist["every"] } })}
              >
                {EVERY.map(([v, label]) => (
                  <option key={v} value={String(v)}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                className="settings-input appearance-select"
                value={playlist.order}
                onChange={(e) => patch({ playlist: { ...playlist, order: e.target.value as Playlist["order"] } })}
              >
                <option value="shuffle">Shuffle</option>
                <option value="in-order">In order</option>
              </select>
            </span>
          </Row>
        )}
        {look.background.kind !== "none" && (
          <>
            <Row label="Fit">
              <select className="settings-input appearance-select" value={look.backgroundStyle.fit} onChange={(e) => bgStyle({ fit: e.target.value as BgFit })}>
                {FITS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Opacity">
              <Slider value={look.backgroundStyle.opacity} min={0} max={100} unit="%" onChange={(opacity) => bgStyle({ opacity })} />
            </Row>
            <Row label="Blur">
              <Slider value={look.backgroundStyle.blur} min={0} max={20} unit="px" onChange={(blur) => bgStyle({ blur })} />
            </Row>
            <Row label="Dim" hint="A dark layer over it, so text stays readable.">
              <Slider value={look.backgroundStyle.dim} min={0} max={90} unit="%" onChange={(dim) => bgStyle({ dim })} />
            </Row>
          </>
        )}
        {/* D: contrast warning */}
        <label className="settings-row">
          <span className="settings-text">
            <b>React to agent state</b>
            <span>Wild backgrounds speed up while an agent works and flash when it needs you.</span>
          </span>
          <input type="checkbox" className="settings-switch" checked={look.reactToState} onChange={(e) => patch({ reactToState: e.target.checked })} />
        </label>
        <label className="settings-row">
          <span className="settings-text">
            <b>Reduce motion</b>
            <span>Still frames instead of animation. Also on when macOS asks for less motion.</span>
          </span>
          <input type="checkbox" className="settings-switch" checked={look.reduceMotion} onChange={(e) => patch({ reduceMotion: e.target.checked })} />
        </label>
      </div>

      <div className="settings-section">Per chat kind</div>
      <div className="settings-list">
        {KINDS.map(([kind, label]) => (
          <LookOverride
            key={kind}
            label={label}
            look={look}
            value={look.perKind[kind]}
            onError={fail}
            onChange={(v) => {
              const perKind = { ...look.perKind };
              if (v) perKind[kind] = v;
              else delete perKind[kind];
              patch({ perKind });
            }}
          />
        ))}
      </div>

      {Object.keys(repos).length > 0 && (
        <>
          <div className="settings-section">Per workspace</div>
          <div className="settings-list">
            {Object.entries(repos).map(([key, repo]) => (
              <LookOverride
                key={key}
                label={repo.label}
                look={look}
                value={look.perWorkspace[key]}
                onError={fail}
                onChange={(v) => {
                  const perWorkspace = { ...look.perWorkspace };
                  if (v) perWorkspace[key] = v;
                  else delete perWorkspace[key];
                  patch({ perWorkspace });
                }}
              />
            ))}
          </div>
          <p className="settings-note">A workspace wins over a chat kind; a chat's own look (right-click it) wins over both.</p>
        </>
      )}

      <div className="settings-section">Theme files</div>
      <div className="appearance-inline appearance-gap">
        <input
          className="settings-input"
          placeholder="Name this look…"
          maxLength={60}
          value={themeName}
          onChange={(e) => setThemeName(e.target.value)}
        />
        <button className="settings-btn-sm primary" disabled={!themeName.trim()} onClick={() => void saveTheme()}>
          Save current as…
        </button>
      </div>
      {themes.length > 0 && (
        <div className="settings-list appearance-gap">
          {themes.map((t) => (
            <div key={t.file} className="settings-row static">
              <span className="settings-text">
                <b>{t.name}</b>
              </span>
              <span className="appearance-inline">
                <button className="settings-btn-sm" onClick={() => applyTheme(t)}>
                  Apply
                </button>
                <button className="settings-btn-sm" onClick={() => void exportTheme(t)}>
                  Export
                </button>
                <button className="settings-btn-sm" onClick={() => void deleteTheme(t)}>
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="appearance-inline appearance-gap">
        <input ref={themeRef} type="file" hidden accept=".json" onChange={(e) => void importTheme(e.target.files?.[0]).then(() => (e.target.value = ""))} />
        <button className="settings-btn-sm" onClick={() => themeRef.current?.click()}>
          Import file…
        </button>
        <button className="settings-btn-sm" disabled={look === opened.current} onClick={() => update(opened.current)}>
          Undo changes
        </button>
        <button className="settings-btn-sm" onClick={() => update(withDefaults(DEFAULT_APPEARANCE))}>
          Restore Crux Dark
        </button>
      </div>
      {notice && <p className="settings-note">{notice}</p>}
    </>
  );
}
