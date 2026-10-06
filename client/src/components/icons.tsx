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
export function JiraIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11M10 2.5v11" />
      <path d="M3.8 5.5h1M7.7 5.5h1M11.6 5.5h1M3.8 8h1M7.7 8h1" strokeLinecap="round" />
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
