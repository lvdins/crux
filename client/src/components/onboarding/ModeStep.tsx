import { useState } from "react";
import type { Settings } from "../../types";
import { useModalKeys } from "../../useModalKeys";
import { ApiIcon, BrowserTestIcon, ClaudeLogo, CodexLogo, DocIcon, TerminalIcon } from "../icons";

const MODES: { mode: Settings["mode"]; title: string; body: string; icons: JSX.Element[] }[] = [
  {
    mode: "qa",
    title: "QA Tool",
    body: "Docs preview, Playwright and pytest trees, coverage, a browser with network view and element picker, and a live Flow view of your agents.",
    icons: [<DocIcon key="d" />, <BrowserTestIcon key="b" />, <ApiIcon key="a" />],
  },
  {
    mode: "regular",
    title: "Regular",
    body: "A clean orchestrator: Claude, Codex and terminals on any folder. Agents still get a browser in the background.",
    icons: [<ClaudeLogo key="c" />, <CodexLogo key="x" />, <TerminalIcon key="t" />],
  },
];

/** "How will you use Crux?" — picks the settings preset. Changeable later in Settings. */
export default function ModeStep({ initial, onDone }: { initial: Settings["mode"]; onDone: (mode: Settings["mode"]) => void }) {
  const [mode, setMode] = useState(initial);
  useModalKeys(true, { onEnter: () => onDone(mode) });

  return (
    <div className="onb-backdrop">
      <div className="onb-card mode-step" role="dialog" aria-label="How will you use Crux?">
        <h2>How will you use Crux?</h2>
        <p>You can change this any time in Settings.</p>
        <div className="mode-cards">
          {MODES.map((m) => (
            <button key={m.mode} className={`mode-card ${mode === m.mode ? "on" : ""}`} onClick={() => setMode(m.mode)}>
              <span className="mode-icons">{m.icons}</span>
              <b>{m.title}</b>
              <span>{m.body}</span>
            </button>
          ))}
        </div>
        <button className="primary mode-go" onClick={() => onDone(mode)}>
          Continue
        </button>
      </div>
    </div>
  );
}
