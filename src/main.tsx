import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PerfShell } from "./ui/dev/PerfShell";
import "./index.css";

// dev 專用效能驗證空殼（?perf=1）：StrictMode 會雙掛載打亂量測，故走獨立分支
const isPerf =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has("perf");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  isPerf ? (
    <PerfShell />
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
