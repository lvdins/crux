import "./fresh"; // app:fresh wipes saved settings first
import "./migrate"; // before anything reads saved settings
// Desktop app on macOS: no title bar, the traffic lights sit in our top bar.
if ("__TAURI_INTERNALS__" in window && /Mac/.test(navigator.platform)) document.documentElement.classList.add("tauri-mac");
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import QuickAsk from "./components/QuickAsk";
import TrayPanel from "./components/TrayPanel";
// Roboto, bundled (works offline): the one UI font across the app.
import "@fontsource-variable/roboto";
import "./styles.css";
import "./themes.css";
import { initTheme } from "./theme";

// The ⌥Space window and the menu bar panel load this same page with
// __CRUX_QUICK__ / __CRUX_TRAY__ set (main.rs).
const quick = !!(window as { __CRUX_QUICK__?: boolean }).__CRUX_QUICK__;
const tray = !!(window as { __CRUX_TRAY__?: boolean }).__CRUX_TRAY__;
if (quick) document.documentElement.classList.add("quick-window");
if (tray) document.documentElement.classList.add("tray-window");
// Saved appearance (theme, accent, motion) on <html> before the first paint.
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{quick ? <QuickAsk /> : tray ? <TrayPanel /> : <App />}</React.StrictMode>,
);
