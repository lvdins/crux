import { useEffect, useRef } from "react";
import type { RegisteredView } from "../extensions";

/** A local extension's view: it renders into this element itself. */
export default function ExtensionPane({ view }: { view: RegisteredView }) {
  const el = useRef<HTMLElement>(null);
  const { key, label, mount } = view;
  // Keyed on the view itself, not the object: a badge update must not remount it.
  useEffect(() => {
    const host = el.current;
    if (!host) return;
    let cleanup: void | (() => void);
    try {
      cleanup = mount(host);
    } catch (err) {
      host.textContent = `${label} failed to load: ${err}`;
    }
    return () => {
      try {
        cleanup?.();
      } finally {
        host.replaceChildren();
      }
    };
  }, [key, mount]); // eslint-disable-line react-hooks/exhaustive-deps
  return <section className="full-pane ext-pane" ref={el} />;
}
