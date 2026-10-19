import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PerfShell } from "./ui/dev/PerfShell";
import { isCaptureWindow } from "./ui/notes/capture-window/shell";
import { CaptureWindowApp } from "./ui/notes/desktop";
import "./index.css";

// dev 專用效能驗證空殼（?perf=1）：StrictMode 會雙掛載打亂量測，故走獨立分支
const isPerf =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has("perf");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  isPerf ? (
    <PerfShell />
  ) : isCaptureWindow() ? <CaptureWindowApp /> : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
