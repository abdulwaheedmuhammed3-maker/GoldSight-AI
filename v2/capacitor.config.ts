import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.tradesight.mobile",
  appName: "TradeSight",
  webDir: "dist",
  bundledWebRuntime: false,
  plugins: {
    // Android WebView REST requests must use native networking to avoid
    // browser CORS failures against third-party market-data providers.
    CapacitorHttp: {
      enabled: true,
    },
    // Expose reliable Android cutout/status-bar insets to the CSS layout.
    SystemBars: {
      insetsHandling: "css",
      initialViewportFitValueHint: "cover",
    },
  },
};

export default config;
