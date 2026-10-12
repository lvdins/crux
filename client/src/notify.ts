/**
 * macOS notifications: the Tauri notification plugin in the desktop app,
 * the browser's Notification API elsewhere (dev in a browser tab).
 */
const inTauri = "__TAURI_INTERNALS__" in window;

/** Asks once; true when notifications may be shown. */
export async function notifyAllowed(ask = false): Promise<boolean> {
  if (inTauri) {
    const n = await import("@tauri-apps/plugin-notification");
    if (await n.isPermissionGranted()) return true;
    return ask ? (await n.requestPermission()) === "granted" : false;
  }
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return ask && Notification.permission !== "denied" ? (await Notification.requestPermission()) === "granted" : false;
}

export async function notify(title: string, body: string): Promise<void> {
  try {
    if (!(await notifyAllowed(true))) return;
    if (inTauri) (await import("@tauri-apps/plugin-notification")).sendNotification({ title, body });
    else new Notification(title, { body });
  } catch {
    /* notifications are best effort */
  }
}
