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

export {};
