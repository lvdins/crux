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
