/**
 * Linux AppImage: its runtime points LD_LIBRARY_PATH, PATH, XDG_DATA_DIRS,
 * GIO/GTK module paths… into the mounted image ($APPDIR) so Crux finds its
 * bundled libraries. Every terminal, agent and tool the server starts would
 * inherit that, and the user's own node / python / cat then load Crux's older
 * libs and crash ("undefined symbol: nghttp2_…", "LIBSYSTEMD_254 not found").
 *
 * Imported first (index.ts): drops every path inside the image from the
 * environment, so children see the user's normal one. $APPIMAGE (the file on
 * disk, used by the updater) is outside the image and stays.
 */
const appDir = process.platform === "linux" ? process.env.APPDIR : undefined;
if (appDir && appDir.length > 1) {
  const inside = (p: string) => p === appDir || p.startsWith(appDir.endsWith("/") ? appDir : appDir + "/");
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !value.includes(appDir)) continue;
    const kept = value.split(":").filter((p) => p && !inside(p));
    if (kept.length) process.env[key] = kept.join(":");
    else delete process.env[key];
  }
}

export {};
