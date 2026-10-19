import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CRUX_HOME, PORT, ROOT } from "./paths.js";

/** Releases (DMG, AppImage, .deb, setup.exe) are published here. The repo is
 *  public: no GitHub login (or gh) is needed to check or download. */
const REPO = "lvdins/crux";
const RELEASES = `https://github.com/${REPO}/releases`;
/** A release file's download link, e.g. Crux_0.1.37_aarch64.dmg. */
const assetUrl = (tag: string, suffix: string) => `${RELEASES}/download/${tag}/Crux_${tag.replace(/^v/, "")}_${suffix}`;

const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * Latest release tag (null when offline). github.com/…/releases/latest
 * redirects to …/releases/tag/<tag>: reading that redirect needs no login and
 * isn't held to the API's 60-an-hour limit, which a whole office shares.
 */
let lastCheck: { at: number; tag: string } | null = null;
export async function latestRelease(): Promise<string | null> {
  if (lastCheck && Date.now() - lastCheck.at < 5 * 60_000) return lastCheck.tag;
  try {
    const res = await fetch(`${RELEASES}/latest`, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const tag = /\/releases\/tag\/([^/?#]+)/.exec(res.headers.get("location") ?? "")?.[1];
    if (!tag) return null;
    lastCheck = { at: Date.now(), tag: decodeURIComponent(tag) };
    return lastCheck.tag;
  } catch {
    return null;
  }
}

/**
 * Download the release's .dmg, quit Crux, swap the app bundle, relaunch.
 * Runs as a detached script so it survives Crux (and this server) quitting.
 */
export function installRelease(tag: string): void {
  if (process.platform === "linux") return installAppImage(tag);
  if (process.platform === "win32") return installWindows(tag);
  // Packaged server lives in <App>.app/Contents/Resources/ql-runtime.
  const app = path.resolve(ROOT, "../../..");
  if (!app.endsWith(".app")) throw new Error("Not running from an installed Crux.app");
  const log = path.join(CRUX_HOME, "update.log");
  const script = `set -e
T=$(mktemp -d -t crux-update)
DMG="$T/Crux.dmg"
curl -fsSL --retry 2 -o "$DMG" "$URL"
mkdir "$T/mnt"
hdiutil attach -nobrowse -quiet -mountpoint "$T/mnt" "$DMG"
ditto "$T/mnt/$(basename "$APP")" "$T/new.app"
# Every copy macOS sees registers the same app ID; leftovers confuse it about
# which one is Crux (notifications go to the wrong copy). Forget the temp ones.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREG" -u "$T/mnt/$(basename "$APP")" 2>/dev/null || true
hdiutil detach -quiet "$T/mnt"
# Refuse a damaged or modified download (its seal must still verify);
# the installed app is left alone if this fails.
codesign --verify --deep --strict "$T/new.app" || { echo "update refused: broken signature"; exit 1; }
osascript -e "quit app \\"$(basename "$APP" .app)\\"" || true
for i in $(seq 1 50); do pgrep -f "$APP/Contents/MacOS/" >/dev/null || break; sleep 0.2; done
pkill -f "$APP/Contents/MacOS/" || true
for i in $(seq 1 25); do pgrep -f "$APP/Contents/" >/dev/null || break; sleep 0.2; done
rm -rf "$APP"
ditto "$T/new.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
"$LSREG" -u "$T/new.app" 2>/dev/null || true
"$LSREG" -f "$APP" 2>/dev/null || true
# Launch Services can refuse (-609) right after the swap: retry.
for i in 1 2 3 4 5 6; do open "$APP" && break; sleep 1; done
rm -rf "$T"
`;
  fs.mkdirSync(CRUX_HOME, { recursive: true });
  const out = fs.openSync(log, "w");
  spawn("/bin/bash", ["-c", script], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, URL: assetUrl(tag, "aarch64.dmg"), APP: app },
  }).unref();
}

/**
 * Linux: the AppImage is one file ($APPIMAGE, set by its runtime). Download
 * the release's AppImage, quit Crux, put the new file in its place, reopen.
 * A .deb install updates through its package instead.
 */
function installAppImage(tag: string): void {
  const appImage = process.env.APPIMAGE;
  if (!appImage) throw new Error("Only the AppImage updates itself: install the new .deb from GitHub releases");
  const log = path.join(CRUX_HOME, "update.log");
  const script = `set -e
T=$(mktemp -d -t crux-update.XXXXXX)
NEW="$T/Crux.AppImage"
curl -fsSL --retry 2 -o "$NEW" "$URL"
chmod +x "$NEW"
kill -TERM "$APP_PID" 2>/dev/null || true
for i in $(seq 1 50); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.2; done
mv -f "$NEW" "$APPIMAGE"
rm -rf "$T"
nohup "$APPIMAGE" >/dev/null 2>&1 &
`;
  fs.mkdirSync(CRUX_HOME, { recursive: true });
  const out = fs.openSync(log, "w");
  // The desktop app started this server: its pid is ours to stop.
  spawn("/bin/bash", ["-c", script], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, URL: assetUrl(tag, "amd64.AppImage"), APPIMAGE: appImage, APP_PID: String(process.ppid) },
  }).unref();
}

/**
 * Windows: run the release's installer (NSIS, per user) silently. Closing the
 * app doesn't stop this server there, so it's asked to save and quit first.
 */
function installWindows(tag: string): void {
  const log = path.join(CRUX_HOME, "update.log");
  const script = `$ErrorActionPreference = 'Stop'
$T = Join-Path $env:TEMP ('crux-update-' + [guid]::NewGuid())
New-Item -ItemType Directory $T | Out-Null
$setup = Get-Item (Join-Path $T 'Crux-setup.exe') -ErrorAction SilentlyContinue
Invoke-WebRequest -UseBasicParsing -Uri $env:URL -OutFile (Join-Path $T 'Crux-setup.exe')
$setup = Get-Item (Join-Path $T 'Crux-setup.exe')
$app = (Get-Process -Id $env:APP_PID).Path
try { Invoke-RestMethod -Method Post "http://127.0.0.1:$env:CRUX_PORT/api/quit" | Out-Null } catch {}
Start-Sleep -Seconds 2
Stop-Process -Id $env:APP_PID -Force -ErrorAction SilentlyContinue
Start-Process $setup.FullName -ArgumentList '/S' -Wait
Start-Process $app
Remove-Item $T -Recurse -Force
`;
  fs.mkdirSync(CRUX_HOME, { recursive: true });
  const out = fs.openSync(log, "w");
  spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, URL: assetUrl(tag, "x64-setup.exe"), APP_PID: String(process.ppid), CRUX_PORT: String(PORT) },
  }).unref();
}
