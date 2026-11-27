import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/dm-sans/800.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import App from "./App";
import { startMarketDataRuntime } from "./domain/market-data/runtime";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("TradeSight root element was not found.");
}

void startMarketDataRuntime();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const serviceWorkerUrl = import.meta.env.BASE_URL + "sw.js";
    void navigator.serviceWorker.register(serviceWorkerUrl, {
      scope: import.meta.env.BASE_URL,
    }).catch((error: unknown) => {
      console.warn("TradeSight offline app shell registration failed", error);
    });
  });
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
