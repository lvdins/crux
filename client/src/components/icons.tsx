const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function DocIcon() {
  return (
    <svg {...base}>
      <path d="M4 1.5h5.5L13 5v9.5H4z" />
      <path d="M9.5 1.5V5H13" />
      <path d="M6 8h5M6 10.5h5" />
    </svg>
  );
}

export function BrowserTestIcon() {
  return (
    <svg {...base}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 5.5h13" />
      <path d="M5 9l1.8 1.8L10.5 7.2" />
    </svg>
  );
}

export function ApiIcon() {
  return (
    <svg {...base}>
      <path d="M5.5 4.5L2 8l3.5 3.5" />
      <path d="M10.5 4.5L14 8l-3.5 3.5" />
    </svg>
  );
}

export function WebIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" strokeWidth="0.9" />
    </svg>
  );
}

export function ClaudeLogo() {
  // Simplified Anthropic spark: tapered rays in brand terracotta.
  const rays = Array.from({ length: 8 }, (_, i) => i * 45);
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="#D97757">
      {rays.map((deg) => (
        <path key={deg} d="M8 8 L6.9 1.8 Q8 1.1 9.1 1.8 Z" transform={`rotate(${deg} 8 8)`} />
      ))}
    </svg>
  );
}

export function CodexLogo() {
  // Simplified OpenAI mark: hexagonal knot ring.
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M8 1.6 L13.5 4.8 V11.2 L8 14.4 L2.5 11.2 V4.8 Z" />
      <path d="M8 5 L10.6 6.5 V9.5 L8 11 L5.4 9.5 V6.5 Z" strokeWidth="1.1" />
    </svg>
  );
}

export function iconFor(kind: string) {
  switch (kind) {
    case "mkdocs":
      return <DocIcon />;
    case "playwright":
      return <BrowserTestIcon />;
    case "pytest":
      return <ApiIcon />;
    default:
      return <DocIcon />;
  }
}

/** Generic ticket-board mark (not the Atlassian logo). */
/** A split view group: two panes side by side. */
export function SplitIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M8 3v10" />
    </svg>
  );
}

export function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z" />
    </svg>
  );
}

export function TerminalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M4.5 6l2 2-2 2M8.5 10.5h3" />
    </svg>
  );
}

/** Orchestrator: one lead node fanning out to workers. */
export function OrchestrateIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="3.5" r="2" />
      <circle cx="3" cy="12.5" r="1.6" />
      <circle cx="8" cy="12.5" r="1.6" />
      <circle cx="13" cy="12.5" r="1.6" />
      <path d="M8 5.5v5.4M6.9 5.2 3.8 11M9.1 5.2l3.1 5.8" />
    </svg>
  );
}

/** Flow view: steps joined left to right. */
export function FlowIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="3" width="4" height="3.5" rx="1" />
      <rect x="10.5" y="1.5" width="4" height="3.5" rx="1" />
      <rect x="10.5" y="11" width="4" height="3.5" rx="1" />
      <path d="M5.5 4.75h2.2c1 0 1.3-1.5 2.8-1.5M7.7 4.75v6c0 1.25.9 2 2.8 2" />
    </svg>
  );
}

/* Flow view: step types and its controls. */
export function ChatIcon() {
  return (
    <svg {...base}>
      <path d="M2.5 3.5h11v7.5H7.5l-3 2.5V11h-2z" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg {...base}>
      <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />
      <path d="M9 4l3 3" />
    </svg>
  );
}

export function WaitIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...base}>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

export function ToolIcon() {
  return (
    <svg {...base}>
      <path d="M9.6 2.4a3.2 3.2 0 0 0-3.4 4.3L2.4 10.5v3.1h3.1l3.8-3.8a3.2 3.2 0 0 0 4.3-3.4l-2 2-2.2-.5-.5-2.2z" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg {...base} width="12" height="12">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function ChevronLeftIcon() {
  return (
    <svg {...base} width="12" height="12">
      <path d="M10 3.5L5.5 8l4.5 4.5" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...base} width="14" height="14">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
