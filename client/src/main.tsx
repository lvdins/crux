import "./fresh"; // app:fresh wipes saved settings first
import "./migrate"; // before anything reads saved settings
// Desktop app on macOS: no title bar, the traffic lights sit in our top bar.
if ("__TAURI_INTERNALS__" in window && /Mac/.test(navigator.platform)) document.documentElement.classList.add("tauri-mac");
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import QuickAsk from "./components/QuickAsk";
import "./styles.css";

// The ⌥Space window loads this same page with __CRUX_QUICK__ set (main.rs).
const quick = !!(window as { __CRUX_QUICK__?: boolean }).__CRUX_QUICK__;
if (quick) document.documentElement.classList.add("quick-window");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{quick ? <QuickAsk /> : <App />}</React.StrictMode>,
);
