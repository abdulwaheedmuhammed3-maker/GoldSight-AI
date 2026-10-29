# GoldSight free market-data architecture

## Current recommended free configuration

- Gold spot reference: XAUS GET https://xaus.com/api/v1/spot?compact=1. No key is required. The provider documents approximately 60-second edge caching, daily history, and an intraday recorder sampled around every 2–5 minutes. Spot values are indicative mid-market references, not executable broker prices.
- Bitcoin: Binance public market-data endpoints can provide BTCUSDT klines and book ticker without an API key. Treat BTCUSDT spot as a proxy, not as identical to a BTCUSD CFD.
- Signal-grade candles: Keep the existing broker/Exness provider separate. Do not manufacture OHLC candles from periodic spot snapshots. If the broker feed is unavailable, keep technical signals disabled.
- Secrets: All provider requests run in the backend. Never place secret keys in Vite environment variables or frontend source.

## New endpoint

GET /api/v1/spot/XAUUSD

Returns an indicative XAUS spot reference with source timestamp, age, freshness status and explicit tradable_quote=false. It does not provide candles, bid/ask, spread or a trading signal. Quotes older than 180 seconds are rejected.

## Current limitations

XAUS documentation describes the gold spot endpoint as cached around 60 seconds and the recorded intraday series as sampled at a slower cadence than a true tick feed. Its daily history is not suitable for 5m/15m structure analysis. Do not use this reference endpoint to generate entries/SL/TP. The existing /api/v1/market/XAUUSD signal route remains dependent on the configured signal-grade provider until a provider with verified intraday OHLC and executable quote coverage is configured.

## Operational verification

1. Deploy this branch after review/merge.
2. Open /api/v1/health to verify backend health.
3. Open /api/v1/spot/XAUUSD to inspect the spot quote's timestamp and freshness.
4. Open /api/v1/market/XAUUSD?timeframe=15m. A 503/OFFLINE response means signal-grade candles are unavailable; do not override it with spot snapshots.
5. Open /api/v1/market/BTCUSD?timeframe=15m to verify BTC feed availability.
