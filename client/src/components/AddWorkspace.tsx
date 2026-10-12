import { useCallback, useEffect, useState } from "react";
import { useModalKeys } from "../useModalKeys";
import { api } from "../net";
import type { RepoInfo } from "../types";

export const KIND_LABELS: Record<string, string> = {
  mkdocs: "Docs (MkDocs)",
  playwright: "E2E tests (Playwright)",
  pytest: "API tests (pytest)",
  frontend: "Frontend app (Next.js)",
  backend: "Backend (Django)",
  generic: "Other (terminal only)",
};

const KIND_HINTS: Record<string, string> = {
  mkdocs: "Live docs preview next to the terminal",
  playwright: "Test tree and web graph next to the terminal",
  pytest: "Test tree and web graph next to the terminal",
  frontend: "Terminals here; Connections reads its features, pages and API calls",
  backend: "Terminals here; Connections maps endpoints to its views",
  generic: "Just terminals — claude and codex still work",
};

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  kind: string;
  dirs: { name: string; kind?: string }[];
}

export default function AddWorkspace({
  onClose,
  onAdded,
  kind: wantedKind,
  title = "Add workspace",
}: {
  /** Preselect this kind (QA setup slots: mkdocs / playwright / pytest). */
  kind?: string;
  title?: string;
  onClose: () => void;
  onAdded: (key: string, repo: RepoInfo) => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState(wantedKind ?? "generic");
  const [saving, setSaving] = useState(false);
  // Inline "New folder" row: null while closed, else the typed name.
  const [newFolder, setNewFolder] = useState<string | null>(null);

  const open = useCallback((target?: string) => {
    setError("");
    api(`/api/fs/list${target ? `?path=${encodeURIComponent(target)}` : ""}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error);
        return body as Listing;
      })
      .then((l) => {
        setListing(l);
        setTyped(l.path);
        setKind(wantedKind ?? l.kind);
        setLabel(l.path.split("/").filter(Boolean).pop() ?? "");
      })
      .catch((err) => setError(String(err.message ?? err)));
  }, [wantedKind]);

  useEffect(() => open(), [open]);

  const createFolder = async () => {
    if (!listing || !newFolder?.trim()) return;
    setError("");
    try {
      const r = await api("/api/fs/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: listing.path, name: newFolder.trim() }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setNewFolder(null);
      open(body.path); // step into it, ready to add
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  };

  // Esc closes (or cancels the new-folder row); Enter stays with the path field (Go).
  useModalKeys(true, { onEscape: () => (newFolder !== null ? setNewFolder(null) : onClose()) });

  const add = async () => {
    if (!listing) return;
    setSaving(true);
    setError("");
    try {
      const r = await api("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: listing.path, label, kind }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      onAdded(body.key, body.repo);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setSaving(false);
    }
  };

  const crumbs = listing ? listing.path.split("/").filter(Boolean) : [];

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Add workspace">
        <div className="modal-head">
          <span>{title}</span>
          <button className="modal-x" onClick={onClose} title="Close">×</button>
        </div>

        <form
          className="path-row"
          onSubmit={(e) => {
            e.preventDefault();
            open(typed);
          }}
        >
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Paste a folder path, e.g. ~/code/playwright"
            spellCheck={false}
          />
          <button type="submit">Go</button>
        </form>

        {listing && (
          <div className="crumbs">
            <button onClick={() => open("/")}>/</button>
            {crumbs.map((c, i) => (
              <span key={i}>
                <button onClick={() => open("/" + crumbs.slice(0, i + 1).join("/"))}>{c}</button>
                {i < crumbs.length - 1 && <span className="crumb-sep">/</span>}
              </span>
            ))}
            <button className="crumb-new" onClick={() => setNewFolder("")} title="Create a folder here">
              + New folder
            </button>
            <button className="crumb-home" onClick={() => open(listing.home)} title="Home folder">~</button>
          </div>
        )}

        <div className="dir-list">
          {listing && newFolder !== null && (
            <form
              className="dir-new"
              onSubmit={(e) => {
                e.preventDefault();
                void createFolder();
              }}
            >
              <input
                autoFocus
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                placeholder="Folder name"
                spellCheck={false}
              />
              <button type="submit" disabled={!newFolder.trim()}>Create</button>
              <button type="button" onClick={() => setNewFolder(null)}>Cancel</button>
            </form>
          )}
          {listing?.parent && (
            <button className="dir-row" onClick={() => open(listing.parent!)}>
              <span className="dir-name">..</span>
            </button>
          )}
          {listing?.dirs.map((d) => (
            <button key={d.name} className="dir-row" onClick={() => open(`${listing.path}/${d.name}`)}>
              <span className="dir-name">{d.name}</span>
              {d.kind && <span className={`kind-badge ${d.kind}`}>{d.kind}</span>}
            </button>
          ))}
          {listing && listing.dirs.length === 0 && <div className="dir-empty">No sub-folders</div>}
        </div>

        {listing && (
          <div className="ws-form">
            <label>
              <span>Name</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label>
              <span>Type</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                    {k === listing.kind && k !== "generic" ? " — detected" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="ws-hint">{KIND_HINTS[kind]}</div>
          </div>
        )}

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-foot">
          <span className="modal-path">{listing?.path}</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!listing || saving} onClick={add}>
            {saving ? "Adding…" : "Add this folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
