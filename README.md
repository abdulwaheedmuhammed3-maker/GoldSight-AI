# TradeSight

TradeSight is a mobile-first market-intelligence and demo-trading platform for **XAUUSD (Gold), BTCUSD (Bitcoin), EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF and NZDUSD**. It combines live market data, multi-timeframe technical analysis, setup history, demo risk management, market news, portfolio tools and a Nigeria economy dashboard. The frontend is built with React, TypeScript and Vite; the API is built with FastAPI. TradeSight does not place live broker orders.

> **Important:** A live quote is not a reliable prediction. Signal confidence is a rule-alignment score, not a calibrated probability of profit. The strategy is not proven profitable; test it on historical data and a demo account before relying on it.

## Current build overview

- **Markets:** XAUUSD, BTCUSD, EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF and NZDUSD.
- **Analysis timeframes:** 5m, 15m, 1h and 4h, with completed-candle higher-timeframe confirmation.
- **Forecasts:** BUY, SELL or NO SETUP, with entry, stop-loss, take-profit levels, invalidation and an explanatory rule-alignment score.
- **Setup history:** saved setups with price-tracked outcomes such as active, void, stop-loss hit and take-profit hit. Outcome labels depend on available market candles; missing or ambiguous evidence should not be treated as a confirmed hit.
- **Demo trading:** simulated account, position sizing and risk controls. No live order execution.
- **Tools and market context:** pip/position sizing tools, currency conversion, market news, stock/portfolio views and Nigerian naira/economy indicators.
- **Notifications:** in-app history and Android Web Push with independent per-device approvals. News can be selected by region (Nigeria, other African countries, USA, UK and Global) and topic (economic or football); trading setups and stock suggestions have separate approvals. Every preference defaults OFF, and browser/Android permission is separate. RSS coverage includes Nigerian publishers, BBC Africa, BBC World, BBC Business Economy and BBC Football alongside official US/UK/EU sources. Africa-region matching excludes headlines clearly identified as Nigeria-related. Stock suggestions have a delivery helper ready, but require a stock-suggestion event source to invoke it. Delivery depends on a running backend, database, VAPID configuration and device permission.
- **Branding:** TradeSight falcon header artwork and Android/PWA app icon are stored in `frontend/public/`.

## Live data sources

- **XAUUSD and FX:** the backend supports configured Exness, OANDA or MT5 provider modes. OANDA requires a valid API token, account ID and account-supported instrument; MT5 requires a running, logged-in terminal on the host. Provider configuration and symbol availability determine whether a market is LIVE. If the configured provider is unavailable or data is stale, TradeSight displays **OFFLINE** rather than inventing a quote or signal.
- **BTCUSD:** uses the configured broker provider unless `BTC_MARKET_DATA_PROVIDER=binance` selects Binance's public BTCUSDT spot endpoint. BTCUSDT is a spot proxy, not identical to a broker BTCUSD CFD; provider details and this limitation must be considered when comparing prices.
- Provider credentials are not embedded in frontend code. MT5 uses the logged-in desktop terminal. Binance public endpoints need no secret key.

## Requirements

- Node.js 22+ and npm
- Python 3.11+ (Windows recommended for Exness MT5 integration)
- A configured market-data provider and valid credentials for the selected provider; a Windows MT5 terminal is required only when using the MT5 provider
- Same trusted Wi-Fi for PC and Android during local LAN testing

## Run on Windows

### 1. Start the backend

PowerShell:
```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
# MetaTrader5 is installed automatically on Windows by requirements.txt
$env:MARKET_DATA_PROVIDER="mt5"
# Optional: set this only if MT5 is installed outside its default location
$env:MT5_TERMINAL_PATH="C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe"
# Override these if your Exness Market Watch uses suffixes or different names
$env:MT5_SYMBOL_XAUUSD="XAUUSD"
$env:MT5_SYMBOL_BTCUSD="BTCUSD"
$env:MT5_SYMBOL_EURUSD="EURUSD"
$env:MT5_SYMBOL_GBPUSD="GBPUSD"
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Before starting the API, install and open **Exness MT5 for Windows**, sign in to the intended account, and confirm the four instruments appear in Market Watch. The bridge uses that logged-in terminal session; do not put your MT5 password in source code, a committed `.env` file, or frontend variables. This integration is read-only and does not call any MT5 order functions.

If PowerShell blocks activation, run `.venv\Scripts\python.exe -m pip install -r requirements.txt`, set the same environment variables in that PowerShell window, then run `.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000`.

Verify the connection:
- `http://127.0.0.1:8000/api/v1/health` should report `provider_mode: mt5`.
- `http://127.0.0.1:8000/api/v1/mt5/status` should report `status: CONNECTED` and `order_execution_enabled: false`.
- `http://127.0.0.1:8000/api/v1/market/XAUUSD?timeframe=15m` should return `status: LIVE`, a fresh bid/ask and candles. Repeat for BTCUSD, EURUSD and GBPUSD.
- If a symbol is not found, set its `MT5_SYMBOL_*` variable to the exact name displayed in Exness Market Watch. If status is OFFLINE, check the terminal is open, logged in and receiving ticks.


### 2. Start the frontend

In another PowerShell window:
```powershell
cd frontend
npm install
# Create frontend/.env.local and use your PC's LAN address for phone testing:
# VITE_API_BASE_URL=http://192.168.1.124:8000
npm run dev -- --host 0.0.0.0
```

Open the URL printed by Vite. From Android on the same Wi-Fi, open `http://192.168.1.124:5173` (or your PC's current LAN IP). Set `VITE_API_BASE_URL=http://192.168.1.124:8000` in `frontend/.env.local` and restart Vite; replace the address if the PC's LAN IP changes. Allow ports 5173 and 8000 through Windows Firewall only on a trusted private network. For LAN use set `CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://YOUR_PC_LAN_IP:5173` before starting the backend.

### 3. Run tests and build

Backend: `cd backend; pytest`. Frontend: `cd frontend; npm run build`.

## Signal logic and limitations

- Supports 5m, 15m, 1h, and 4h analysis.
- Uses completed candles only for EMA trend, recent structure break (BOS), sweep checks, and candle confirmation; spread is checked against proposed risk.
- BUY/SELL only appears when trend, structure/sweep and candle confirmation align. Otherwise the correct output is NO SETUP.
- SL uses recent structure plus an average-range buffer; TP1/TP2/TP3 target 1R/2R/3R.
- Signals are deterministic technical rules, not a trained AI model. Confidence is an uncalibrated alignment score. No backtest, win-rate or profitability claim is made.
- Signals on 5m require aligned 15m, 1h and 4h trends; 15m requires aligned 1h and 4h; 1h requires aligned 4h. A setup is suppressed to NO SETUP if higher-timeframe data is offline or trend disagrees. The 4h signal is evaluated on its own timeframe. Persistent setup history requires `DATABASE_URL` pointing to PostgreSQL; the server polls 5m setups every minute and slower timeframes every 5 minutes and deduplicates by signal candle. Historical setups from before the recorder was deployed cannot be recovered unless the strategy is explicitly replayed over historical candles.
- The chart refreshes every 15 seconds. When the provider is unavailable, the UI shows OFFLINE and hides price candles/signals.
- No live broker order placement or broker-account trading. Persistent setup history and demo account state require PostgreSQL (`DATABASE_URL`). The current MVP is not a full multi-user authenticated trading platform.

## Environment variables

Backend: `MARKET_DATA_PROVIDER=mt5` to select Exness MT5, optional `MT5_TERMINAL_PATH`, optional `MT5_SYMBOL_XAUUSD`, `MT5_SYMBOL_BTCUSD`, `MT5_SYMBOL_EURUSD`, `MT5_SYMBOL_GBPUSD`, `CORS_ORIGINS`, `DATABASE_URL` (required for persistent setup history), optional `SETUP_RECORDER_INTERVAL_SECONDS` (minimum 60).
Frontend: `VITE_API_BASE_URL`. Vite environment values are public, so never put secrets there.

## Deployment

For direct MT5 use, the FastAPI backend must run on the Windows PC/VPS where Exness MT5 is installed and logged in. The existing Render Linux backend cannot attach to a terminal on your PC. For first testing, run the frontend and backend on the same trusted Wi-Fi and point `VITE_API_BASE_URL` at the Windows PC LAN address. The deployed public frontend will continue using its configured cloud API until you deliberately connect it to the Windows backend through a properly secured HTTPS tunnel or a separately authenticated outbound data bridge. Do not expose port 8000 or the MT5 terminal directly to the public internet; use a VPN/secure tunnel, HTTPS, authentication and firewall restrictions before remote access. Free-tier hosts may sleep or block long-running services; verify uptime before relying on signals.


## Android-only test while the PC is off (cloud deployment)

The backend can run on Render and the frontend on Vercel, so you can test the dashboard from Android. **On a generic Linux cloud host, XAUUSD remains OFFLINE** because the Exness MT5 Python integration requires a Windows machine running the terminal. BTC can use Binance BTCUSDT spot data.

### Deploy the backend to Render

1. Open [Render](https://render.com/) in your Android browser and sign in.
2. Choose **New → Blueprint** and connect the GitHub repository `abdulwaheedmuhammed3-maker/GoldSight-AI`.
3. Render should detect the root `render.yaml`. Review the service and create it using the free plan if available.
4. Wait for deployment. Copy the service URL, for example `https://goldsight-ai-api.onrender.com` (use the actual URL Render gives you).
5. Test these URLs in your phone browser, replacing the example host:
   - `https://YOUR-RENDER-HOST/api/v1/health`
   - `https://YOUR-RENDER-HOST/api/v1/market/BTCUSD?timeframe=15m`
   - `https://YOUR-RENDER-HOST/api/v1/market/XAUUSD?timeframe=15m`
6. Expected result: health returns JSON; BTC returns `status: LIVE` if Binance is reachable; XAUUSD reports `status: OFFLINE` on Linux without MT5. A free instance may sleep and take time to wake.

### Deploy the frontend to Vercel

1. Open [Vercel](https://vercel.com/) on Android and import the same GitHub repository.
2. Set **Root Directory** to `frontend` and Framework Preset to **Vite**.
3. Add the environment variable `VITE_API_BASE_URL` with the exact Render service URL (no trailing slash), e.g. `https://YOUR-RENDER-HOST`.
4. Deploy and open the Vercel URL on your Android phone. If API requests fail, verify the Render URL and check browser developer tools/logs when available.

The Render blueprint currently allows cross-origin GET requests from any origin for this public, read-only MVP. Before adding private account data or write endpoints, restrict `CORS_ORIGINS` to the exact Vercel domain and add appropriate authentication/security controls.

### What this proves (and what it does not)

- It verifies that the frontend can load on Android, the cloud API can respond, and the BTC spot data path can work independently of your PC.
- It does **not** verify the Exness XAUUSD broker feed, MT5 candle correctness on your account, strategy profitability, or order execution.
- Do not treat a BUY/SELL signal as guaranteed. Confirm quotes, timestamps, spread and levels against your broker before demo testing.


## Persistent setup history

- Configure `DATABASE_URL` on the backend with a persistent PostgreSQL connection string. The API creates its `goldsight_setup_history` table automatically at startup.
- The backend recorder evaluates XAUUSD and BTCUSD on 5m every minute and 15m/1h/4h every five minutes, independently of whether a browser is open. Only fresh, confirmed BUY/SELL setups are stored; repeated polls for the same signal candle are deduplicated.
- Endpoints: `/api/v1/setups/history?limit=50` and `/api/v1/setups/recorder-status`.
- This is observation history, not a record of every possible intrabar setup. The service must remain running; sleeping/free web services pause monitoring, so dependable 24/7 capture needs an always-on worker or scheduled service. Configure a persistent database before expecting history to survive deploys/restarts.
- The recorder cannot recreate setups from before it was enabled unless you run an explicit historical replay, which is not performed automatically.


## Fundamental news feed

- Endpoint: `/api/v1/fundamentals/news?limit=30` (optional `refresh=true` forces a provider refresh).
- Aggregates public RSS headlines from the Federal Reserve, US Bureau of Labor Statistics, and CoinDesk. The backend caches results for five minutes, deduplicates links, includes source/publication timestamps and links, and marks each feed LIVE/OFFLINE.
- No API key is required for these RSS sources. Feed availability and publisher terms can change; the UI shows an unavailable state instead of inventing headlines. The current MVP is a news headline feed, **not a complete economic calendar** and does not include guaranteed release forecasts/actuals.
- Asset relevance and impact labels are keyword-based triage only. They do not infer bullish/bearish direction and must not be treated as a trade signal. Verify the full article and compare it with live price action.
- Provider calls happen on the backend; no provider secrets are exposed in Vite/frontend environment variables. The public API is read-only; restrict CORS and add rate limiting/authentication before adding sensitive or write operations.


## News-aware setup tags

- Confirmed BUY/SELL setups are tagged **NEWS TRADE** only when a high-impact RSS headline tagged for the same asset has a valid publication timestamp within the 30 minutes before the signal candle. Otherwise the setup is tagged **TECHNICAL TRADE**. No active setup is tagged **NO TRADE**.
- The setup card links the matching headline and shows its source, publication time and time gap. This is temporal association, not proof that news caused the move. RSS headlines are not a complete economic calendar; missing or stale feeds cannot prove there was no event.
- Setup history persists the tag and linked news context for newly recorded setups. Existing rows are migrated with a safe default tag and no fabricated news context.
- This feature does not add upcoming-event countdowns, verified forecasts/actuals, or automatic blackout windows. Those require a dedicated economic-calendar provider.


## Setup notifications (Android push + in-app history)

The dashboard supports persistent notification history and Web Push for installed/opened Android Chrome PWAs. Push is generated when the server-side recorder inserts a new, fresh BUY/SELL setup for a supported market and when its news poll discovers eligible high-impact or Nigeria-related RSS headlines. News alerts are deduplicated by article identity and tapping one opens the publisher's HTTPS article. Duplicate signal candles/headlines are suppressed; NO SETUP and offline news feeds do not create alerts. News impact and asset tags are keyword-based triage, not directional trading signals, and RSS is not a complete economic calendar.

Required backend configuration:
- `DATABASE_URL`: persistent PostgreSQL database (stores device subscriptions and notification history).
- `VAPID_PUBLIC_KEY`: public VAPID key, safe to expose through the public-key endpoint.
- `VAPID_PRIVATE_KEY`: private VAPID key; keep only in the backend secret environment.
- `VAPID_CLAIMS_EMAIL`: contact URI such as `mailto:admin@example.com`.

Generate a VAPID key pair locally with Node.js:
```bash
npx --yes web-push generate-vapid-keys
```
Copy the public and private keys into the Render backend environment variables above. Never commit the private key or put it in a `VITE_*` frontend variable. Redeploy the backend after setting them. The backend installs `pywebpush` from `backend/requirements.txt`.

On Android:
1. Open the deployed HTTPS TradeSight site in Chrome.
2. Use Chrome's menu → **Add to Home screen** / **Install app**.
3. Open the installed TradeSight app and tap **Enable Android push notifications**.
4. Allow notifications when Android/Chrome asks.

The frontend registers `/sw.js`; the service worker displays push messages when the app is not open and opens TradeSight when tapped. The notification history endpoint is `/api/v1/notifications`; subscription endpoints are `/api/v1/push/public-key` and `/api/v1/push/subscribe`.

**Availability limitation:** The backend setup recorder must be running to detect new setups. A sleeping Render free web service pauses background polling, so push delivery is not guaranteed while it sleeps. For dependable around-the-clock alerts, use an always-on backend/worker and persistent PostgreSQL. Browser/Android battery settings and notification permissions can also delay or suppress delivery. Test with demo alerts before relying on this for time-sensitive decisions.


## Latest TradeSight branding and build

The current frontend uses the TradeSight name and falcon artwork. The header image is `frontend/public/tradesight-header-logo.png`; the PWA/browser icon is `frontend/public/tradesight-app-icon.png`. The PWA manifest and HTML icon links reference these files. The previous `goldsight-icon.svg` remains in the repository as a legacy asset but is no longer the active manifest/browser icon.

The repository's GitHub Actions workflow runs the automated backend and frontend checks on commits. A passing CI run verifies the code checks/build for that commit; it does not by itself prove that Render has finished deploying or that live market providers are connected. Check the [GitHub Actions runs](https://github.com/abdulwaheedmuhammed3-maker/GoldSight-AI/actions) and the hosting dashboard for current deployment status.


## Latest responsive layout repair

- The responsive shell overrides are loaded from `frontend/src/layout-fixes.css` after the main stylesheet. They keep the falcon wordmark and market-status indicator within the header at phone widths, and lock the five main navigation tabs to equal-width columns so they remain centered and do not drift after layout changes.
- The repair is CSS-only: it preserves the existing TradeSight name, screen content, navigation destinations, market logic and branding assets.
- Latest layout repair commit: `ec5d1831f998dae18271086260e7b4adc0598324`. Confirm the frontend production build and hosting deployment before treating the fix as live.


## Last-known quote and offline display update

- TradeSight now stores the most recent verified LIVE quote for each supported market in browser local storage, separately from cached chart candles.
- When a feed disconnects, the dashboard keeps displaying that last verified price and its original provider timestamp, but the status remains **OFFLINE · LAST KNOWN PRICE**. Cached prices are never relabeled as live and are not used to generate new signals.
- If no prior verified quote exists on that device, the market tile and chart price area display **OFFLINE** rather than a dash.
- The responsive header gives the full falcon wordmark more room beside the market connection status on narrow Android screens.


## Light mode contrast repair

- Restored a complete light palette for the app root and body instead of changing only the background.
- Updated text, muted labels, settings groups, cards, market tiles, inputs, buttons, expandable sections, and bottom navigation for readable contrast.
- Dark mode rules remain scoped to `data-theme="dark"`; light mode styles apply only to `data-theme="light"`.
- CSS is loaded after the base stylesheet through `frontend/src/layout-fixes.css`.


## Mobile header wordmark clipping fix

- Reworked the phone header into a two-column grid, reserving explicit space for the full TradeSight wordmark and a separate offline/last-quote status column.
- Removed flex shrink from the logo container at mobile widths and made the image scale proportionally inside its full allocated column.
- Kept the change scoped to mobile breakpoints; desktop header layout is unchanged.


## Market tile closed-session label

- When a market has no quote and its standard FX session is closed, the large tile value now reads **MARKET CLOSED** instead of **OFFLINE**.
- The label uses the existing New York session calendar; BTCUSD is excluded because crypto trades continuously. When an FX session is open but its feed is unavailable, the tile continues to show **OFFLINE**.


## Market tile and app activity status refinement

- Removed the duplicate red **MARKET CLOSED** label from the top-right market tile badge; that badge now reports only **LIVE** or **OFFLINE**.
- The large main tile value remains **MARKET CLOSED** during scheduled FX/Gold closure and is now red in both themes.
- The header now reports application presence (**ONLINE · App active**) while the page is visible/focused, and **AWAY · App in background** when the user switches away. This is intentionally separate from quote/provider status: market tiles continue to report actual feed availability.

## Direct Exness MT5 integration (read-only)

The MT5 adapter in `backend/app/market.py` reads the logged-in Windows terminal using the official MetaTrader5 Python package. On Windows, `backend/requirements.txt` installs that package with a platform marker; Linux Render deployments skip it and continue to use their configured cloud provider.

- Set `MARKET_DATA_PROVIDER=mt5` on the Windows backend.
- Optional `MT5_TERMINAL_PATH` points to `terminal64.exe` if the terminal is not installed in the default location.
- Optional `MT5_SYMBOL_XAUUSD`, `MT5_SYMBOL_BTCUSD`, `MT5_SYMBOL_EURUSD`, and `MT5_SYMBOL_GBPUSD` override exact Market Watch symbol names for suffixes or broker naming differences.
- `GET /api/v1/mt5/status` is a read-only diagnostic. It does not return account number, balance or credentials and explicitly reports that order execution is disabled.
- Market endpoints read the current tick and broker candles. Quotes older than 180 seconds are rejected as stale. Signals continue to use completed candles only.
- This data integration does not submit, modify or close orders. Keep trading disabled in the app; this is a market-data bridge only.

## November 2026 audit fixes

- Setup history now marks a detected setup **VOID** when price reaches a take-profit target before touching the entry price. Candles that also touch entry are not incorrectly treated as target-before-entry; ambiguous stop/target candles continue to use the conservative stop-first rule.
- The background setup recorder no longer runs the demo trade processor a second time for the same market evaluation. The market endpoint remains the single processing path.
- Currency flags now have a Unicode flag fallback when the remote flag image fails; the Euro area uses its regional flag fallback.
- The service worker cache was versioned to the TradeSight shell and its push notification title, icon and badge now use TradeSight branding.
- Added regression tests for BUY/SELL missed-entry targets, candles that also touch entry, and candles that do not reach a target.
- These changes are committed to the default branch. A green CI run verifies automated tests and compilation; live provider, PostgreSQL, push delivery and deployed-device behaviour still require environment-level checks.



## Native Android app (Capacitor)

TradeSight can also be installed as a native Android application using Capacitor. The native package reuses the React frontend and the existing API; it does not place live broker orders.

### Build locally

Requirements: Node.js 22+, Python 3 with Pillow, Android Studio 2025.2.1 or newer, Android SDK API 36, and JDK 21.

From PowerShell:

```powershell
cd frontend
npm install
python -m pip install Pillow
npm run android:init
npm run android:open
```

For later frontend updates, run `npm run android:sync`, then build the APK in Android Studio or run `cd android; .\\gradlew assembleDebug`.

The Android launcher icon is generated from `public/tradesight-app-icon-512.png`. The launch theme uses a matching dark background and a transparent system launch graphic so the unwanted centered icon is not shown; the app then displays the full TradeSight eagle splash with its spinner and loading label. Android 12+ still owns the initial system transition, so a very brief matching background may appear before the WebView draws the full splash.

### Download a test APK from GitHub

Every Android workflow build creates a debug APK artifact. Open the repository's **Actions → TradeSight Android APK** workflow, select the successful run, and download the `TradeSight-Android-debug` artifact. This is a test build, not a Play Store-signed release.

### Native app notes

- Existing charts, analysis, market history, news, converter and settings continue to use the same React code and configured API.
- The PWA's Web Push delivery is not automatically converted into native Android push. Native push requires Firebase/FCM app configuration and a native push integration before it can be enabled in the APK.
- The PWA remains available separately; the Android APK is a separate installation.


## Native Android app (Capacitor)

TradeSight can also be installed as a native Android application using Capacitor. The native package reuses the existing React frontend and configured API; it does not place live broker orders.

### Build locally

Requirements: Node.js 22+, Python 3 with Pillow, Android Studio 2025.2.1 or newer, Android SDK API 36, and JDK 21.

From PowerShell:

```powershell
cd frontend
npm install
python -m pip install Pillow
npm run android:init
npm run android:open
```

For later frontend updates, run `npm run android:sync`, then build the APK in Android Studio or run `cd android; .\\gradlew assembleDebug`.

The Android launcher icon is generated from `public/tradesight-app-icon-512.png`. The Android launch theme uses a matching dark background and a transparent system launch graphic, so the duplicate centered icon is not displayed. The native splash is held until React mounts the full-screen eagle artwork, spinner and loading label, then the native splash is dismissed.

### Download a test APK from GitHub

The **TradeSight Android APK** workflow builds a debug APK on pushes to the frontend and can also be started manually. Open the repository's **Actions → TradeSight Android APK**, select a successful run, and download the `TradeSight-Android-debug` artifact. This is a test build, not a Play Store-signed release.

### Native app notes

- Existing charts, analysis, market history, news, converter and settings continue to use the same React code and configured API.
- The PWA remains available separately; the Android APK is a separate installation.
- Web Push delivery is not automatically converted to native Android push. Native push requires Firebase/FCM app configuration and native push integration before it can be enabled in the APK.
