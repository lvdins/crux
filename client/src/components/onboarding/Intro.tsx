import { useEffect, useRef, useState } from "react";
import { ClaudeLogo, CodexLogo, DocIcon, BrowserTestIcon, ApiIcon } from "../icons";

// Tool logos that drift up through the spotlights before the Crux mark lands.
const FLYERS = [
  { icon: <DocIcon />, x: 18, delay: 0.25, tilt: -14 },
  { icon: <ClaudeLogo />, x: 34, delay: 0.55, tilt: 8 },
  { icon: <BrowserTestIcon />, x: 82, delay: 0.4, tilt: 12 },
  { icon: <CodexLogo />, x: 66, delay: 0.75, tilt: -9 },
  { icon: <ApiIcon />, x: 50, delay: 0.95, tilt: 4 },
];

const DURATION = 5200;

/** First-launch splash: spotlights sweep in, logos rise, "Welcome to Crux". Any key or click skips. */
export default function Intro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    const finish = () => {
      if (done.current) return;
      done.current = true;
      setLeaving(true);
      setTimeout(onDone, 420);
    };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(finish, reduced ? 2400 : DURATION);
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      finish();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", finish, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", finish, true);
    };
  }, [onDone]);

  return (
    <div className={`intro ${leaving ? "leaving" : ""}`} role="presentation">
      <div className="intro-beam left" />
      <div className="intro-beam right" />
      <div className="intro-floor" />
      {FLYERS.map((f, i) => (
        <span
          key={i}
          className="intro-flyer"
          style={{ left: `${f.x}%`, animationDelay: `${f.delay}s`, ["--tilt" as string]: `${f.tilt}deg` }}
        >
          {f.icon}
        </span>
      ))}
      <div className="intro-center">
        <img src="/crux-mark.svg" alt="" className="intro-mark" />
        <h1 className="intro-title">
          Welcome to <b>CRUX</b>
        </h1>
        <p className="intro-tagline">Where it all comes together.</p>
      </div>
      <div className="intro-skip">Press any key to continue</div>
    </div>
  );
}
