# GoldSight AI

Mobile-first live market monitoring and rule-based signal analysis for **XAUUSD** and **BTCUSD**. React + TypeScript + Vite frontend; FastAPI backend. No trade execution.

> **Important:** A live quote is not a reliable prediction. Signal confidence is a rule-alignment score, not a calibrated probability of profit. The strategy is not proven profitable; test it on historical data and a demo account before relying on it.

## Live data sources

- **XAUUSD:** Exness MT5 terminal through the Windows-only `MetaTrader5` Python package. The terminal must be installed, signed in and receiving quotes. If MT5 is unavailable or the symbol name is wrong, GoldSight displays **OFFLINE**, no quote, and no signal. No fabricated/sample fallback.
- **BTCUSD:** MT5 broker feed is preferred. If MT5 is unavailable, the app uses Binance's free public BTCUSDT spot endpoint without an API key. BTCUSDT is a spot proxy, not identical to an Exness BTCUSD CFD; provider and this limitation are shown in the UI.
- Provider credentials are not embedded in frontend code. MT5 uses the logged-in desktop terminal. Binance public endpoints need no secret key.

## Requirements

- Node.js 20+ and npm
- Python 3.11+ (Windows recommended for Exness MT5 integration)
- Exness MT5 terminal installed, logged in, and showing a live XAUUSD quote
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
pip install MetaTrader5
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

If PowerShell blocks activation, run `.venv\Scripts\python.exe -m pip install -r requirements.txt` and `.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000`.

Check `http://127.0.0.1:8000/api/v1/health` and `http://127.0.0.1:8000/docs`.

If Exness uses a different Market Watch symbol, set the exact names before launching:
```powershell
$env:MT5_SYMBOL_XAUUSD="XAUUSD"
$env:MT5_SYMBOL_BTCUSD="BTCUSD"
```

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
- No order placement, account access, database or authentication.

## Environment variables

Backend: `CORS_ORIGINS`, optional `MT5_SYMBOL_XAUUSD`, optional `MT5_SYMBOL_BTCUSD`, `DATABASE_URL` (required for persistent setup history), optional `SETUP_RECORDER_INTERVAL_SECONDS` (minimum 60).
Frontend: `VITE_API_BASE_URL`. Vite environment values are public, so never put secrets there.

## Deployment

For broker-feed use, host the backend on the Windows PC with Exness MT5 running. A generic Linux server or static-only frontend deployment cannot connect to the desktop terminal. You can deploy the frontend separately, but configure backend CORS and `VITE_API_BASE_URL`. Do not expose the broker terminal or backend publicly without authentication, HTTPS, and firewall/network hardening. Free-tier hosts may sleep or block long-running services; verify uptime before relying on signals.


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
