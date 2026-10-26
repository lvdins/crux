import { useEffect, useState } from "react";
import { api } from "../net";
import ContextMenu, { MenuIcons } from "./ContextMenu";
import { GlobeIcon } from "./icons";

export interface PortInfo {
  port: number;
  pid: number;
  command: string;
  termId: string;
  ws: string;
  isShell: boolean;
  title?: string;
}

const OPEN_KEY = "crux.portsOpen";
const urlOf = (p: PortInfo) => `http://localhost:${p.port}/`;
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Opens a localhost page in the system browser (server side: Tauri has no opener). */
export const openExternal = (url: string) => post("/api/open-external", { url });

/** Sidebar → Ports: servers started from Crux terminals. The header always shows; collapsed when none run. */
export default function PortsPanel({
  labels,
  onOpen,
  onToast,
}: {
  /** workspace key → label */
  labels: Record<string, string>;
  onOpen: (url: string) => void;
  onToast: (msg: string) => void;
}) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [menu, setMenu] = useState<null | { p: PortInfo; x: number; y: number }>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/api/ports")
        .then((r) => (r.ok ? r.json() : []))
        .then((p: PortInfo[]) => alive && setPorts(p))
        .catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? "0" : "1");
      } catch {
        /* private window */
      }
      return !o;
    });

  const stop = async (p: PortInfo) => {
    const r = await post(`/api/ports/${p.pid}/stop`, { force: p.isShell }).catch(() => null);
    if (r?.status === 404) onToast(`:${p.port} already stopped`);
    else if (!r?.ok) onToast(`Couldn't stop :${p.port}`);
    setPorts((ps) => ps.filter((x) => x.pid !== p.pid));
  };

  // Nothing running: just the collapsed header.
  const shown = open && ports.length > 0;
  return (
    <div className="ports-panel">
      <button className={`ports-head ${shown ? "" : "collapsed"}`} onClick={toggle} aria-expanded={shown}>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 3.75 5 6.25l2.5-2.5" />
        </svg>
        Ports
        <span className="ports-count">{ports.length}</span>
      </button>
      {/* Same grid-rows collapse as the sidebar's other sections (side-sub). */}
      <div className={`ports-body ${shown ? "" : "collapsed"}`}>
        <div className="ports-list">
          {ports.map((p) => (
            <button
              key={p.port}
              className="ports-row"
              title={`${urlOf(p)} · ${p.command} (pid ${p.pid})`}
              onClick={() => onOpen(urlOf(p))}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ p, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="ports-dot" />
              <span className="ports-port">:{p.port}</span>
              <span className="ports-name">{p.title ?? p.command}</span>
              <span className="ports-ws">{labels[p.ws] ?? p.ws}</span>
            </button>
          ))}
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          groups={[
            [
              { label: "Open in system browser", icon: <GlobeIcon />, onSelect: () => void openExternal(urlOf(menu.p)) },
              {
                label: "Copy URL",
                icon: MenuIcons.copy,
                onSelect: () =>
                  void navigator.clipboard.writeText(urlOf(menu.p)).then(
                    () => onToast("Copied URL"),
                    () => onToast("Couldn't copy"),
                  ),
              },
            ],
            [
              {
                // The label is the confirmation for a shell: stopping it closes the terminal.
                label: menu.p.isShell ? "Stop process (closes its terminal)" : "Stop process",
                icon: MenuIcons.trash,
                danger: true,
                onSelect: () => void stop(menu.p),
              },
            ],
          ]}
        />
      )}
    </div>
  );
}
