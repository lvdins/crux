// `npm run app:fresh`: forget every saved UI setting once per launch, so the
// app looks exactly like a brand-new install (no boards, bookmarks, layout).
if (import.meta.env.VITE_CRUX_FRESH && !sessionStorage.getItem("crux.freshCleared") && !(window as { __CRUX_QUICK__?: boolean }).__CRUX_QUICK__) {
  for (const key of Object.keys(localStorage)) if (key.startsWith("crux.")) localStorage.removeItem(key);
  sessionStorage.setItem("crux.freshCleared", "1");
}
