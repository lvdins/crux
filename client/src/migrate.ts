// One-time copy of saved UI settings from the app's old name (qualitylab.*).
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith("qualitylab.")) continue;
    const next = "crux." + key.slice("qualitylab.".length);
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key) ?? "");
  }
} catch {
  /* storage unavailable */
}

// The Jira view became a general Browser view (0.1.10): its saved boards move
// into the browser's bookmark bar once.
try {
  const boards = JSON.parse(localStorage.getItem("crux.jiraBoards") ?? "[]");
  if (Array.isArray(boards) && boards.length && !localStorage.getItem("crux.jiraBoardsMoved")) {
    const fallback = [{ name: "Local :3000", url: "http://localhost:3000/" }];
    const saved = JSON.parse(localStorage.getItem("crux.bookmarks") ?? "null");
    const marks: { name: string; url: string }[] = Array.isArray(saved) ? saved : fallback;
    for (const b of boards) if (b?.url && !marks.some((m) => m.url === b.url)) marks.push({ name: b.name, url: b.url });
    localStorage.setItem("crux.bookmarks", JSON.stringify(marks));
    localStorage.setItem("crux.jiraBoardsMoved", "1");
  }
} catch {
  /* storage unavailable */
}

export {};
