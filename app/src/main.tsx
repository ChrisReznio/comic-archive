import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { CoverageProvider } from "./lib/coverage";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <CoverageProvider>
        <App />
      </CoverageProvider>
    </HashRouter>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}
