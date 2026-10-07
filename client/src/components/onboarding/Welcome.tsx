import { useEffect, useState, type ReactNode } from "react";
import { useModalKeys } from "../../useModalKeys";
import { ClaudeLogo, CodexLogo, DocIcon, BrowserTestIcon, ApiIcon, TerminalIcon } from "../icons";

const CARDS: { art: ReactNode; title: string; body: string }[] = [
  {
    art: (
      <div className="wel-art stack">
        <span className="wel-ws" style={{ background: "#d9a05b" }}>D</span>
        <span className="wel-ws" style={{ background: "#7ec98f" }}>E</span>
        <span className="wel-ws" style={{ background: "#6fa8dc" }}>A</span>
      </div>
    ),
    title: "Workspaces are your repos",
    body: "Point Crux at folders you already have. Nothing is copied or moved. Each one shows up in the sidebar.",
  },
  {
    art: (
      <div className="wel-art chips">
        <span className="wel-chip"><ClaudeLogo /> Claude</span>
        <span className="wel-chip"><CodexLogo /> Codex</span>
        <span className="wel-chip"><TerminalIcon /> Terminal</span>
      </div>
    ),
    title: "Chat with agents inside each repo",
    body: "Start Claude or Codex chats in a workspace. They work directly in that folder. Name them so you can find them later.",
  },
  {
    art: (
      <div className="wel-art chips">
        <span className="wel-chip"><DocIcon /> Docs preview</span>
        <span className="wel-chip"><BrowserTestIcon /> Test tree</span>
        <span className="wel-chip"><ApiIcon /> API tests</span>
      </div>
    ),
    title: "The right panel for each repo",
    body: "Crux detects what a folder is and adds the matching panel: a live docs preview, a test tree with coverage, or a browser.",
  },
];

/** Three short cards explaining Crux. Arrow keys work too. */
export default function Welcome({ name, onNext, onSkip }: { name: string; onNext: () => void; onSkip: () => void }) {
  const [i, setI] = useState(0);
  const last = i === CARDS.length - 1;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") (last ? onNext() : setI(i + 1));
      if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [i, last, onNext]);

  useModalKeys(true, { onEnter: () => (last ? onNext() : setI(i + 1)), onEscape: onSkip });

  const card = CARDS[i];
  return (
    <div className="onb-backdrop">
      <div className="onb-card welcome" role="dialog" aria-label="Welcome to Crux">
        <div className="wel-stage" key={i}>
          {i === 0 && name && <div className="wel-hello">Nice to meet you, {name}</div>}
          {card.art}
          <h2>{card.title}</h2>
          <p>{card.body}</p>
        </div>
        <div className="onb-foot">
          <div className="onb-dots">
            {CARDS.map((_, n) => (
              <button key={n} className={n === i ? "on" : ""} aria-label={`Card ${n + 1}`} onClick={() => setI(n)} />
            ))}
          </div>
          <button className="onb-link" onClick={onSkip}>Skip</button>
          {i > 0 && <button onClick={() => setI(i - 1)}>Back</button>}
          <button className="primary" onClick={() => (last ? onNext() : setI(i + 1))}>
            {last ? "Set up Crux →" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
