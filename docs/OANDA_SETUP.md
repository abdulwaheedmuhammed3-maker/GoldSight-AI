# Configure OANDA market data on Render

GoldSight reads OANDA quotes server-side. It does not place orders. It fails closed (OFFLINE, no price/candles) until valid credentials and an available account instrument are verified.

## Before configuration

1. Create/sign in to an OANDA account that supports REST v20 in your division.
2. Generate a personal API access token from OANDA's account portal.
3. Copy the v20 account ID for the account you want to query.
4. Confirm that `XAU_USD` is listed among that account's available instruments. Instrument availability depends on OANDA's division/account. The API verifies this at runtime; it is not assumed.
5. Start with a practice/demo token and account.

## Render environment variables

In Render Dashboard → your `goldsight-ai-api` service → Environment, add:

- `MARKET_DATA_PROVIDER` = `oanda`
- `OANDA_ENVIRONMENT` = `practice` (use `live` only with a live OANDA account/token)
- `OANDA_API_TOKEN` = your secret personal access token
- `OANDA_ACCOUNT_ID` = your OANDA v20 account ID
- Optional `OANDA_INSTRUMENT_XAUUSD` = `XAU_USD` (only change if OANDA lists a different exact instrument)
- Optional `OANDA_INSTRUMENT_BTCUSD` = `BTC_USD` (only if this instrument is listed for your account)

Never commit tokens or account credentials to GitHub, paste them into chat, or put them in frontend `VITE_*` variables. Render stores them as service environment variables. Save changes and redeploy.

## Verification

- Open `https://YOUR-RENDER-SERVICE.onrender.com/api/v1/health`. It should report `provider_mode: oanda`; this endpoint alone does not prove a successful quote.
- Open `/api/v1/market/XAUUSD?timeframe=15m`. A successful response must have `status: LIVE`, provider `OANDA v20 API`, a non-null bid/ask/price, fresh `updated_at`, and candles.
- If it returns `503 OFFLINE`, read `signal.reasons[0]`. Common causes are missing secrets, wrong practice/live host, invalid token/account ID, or the instrument not being available to the account.
- Do not label data LIVE unless the endpoint has validated a fresh OANDA quote.
