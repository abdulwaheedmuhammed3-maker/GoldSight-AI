# Exness market-data setup

This adapter is read-only. It fetches candles and live ticks; it does not place or manage orders.

## Render environment

- `MARKET_DATA_PROVIDER=exness`
- `EXN_API_KEY`: API key identifier from Exness Key Management
- `EXN_PRIVATE_KEY`: Ed25519 signing key in PEM format or base64url-encoded 32-byte seed
- `EXN_ACCOUNT_ID`: numeric trading account ID linked to the key
- `EXN_DISCOVERY_BASE_URL=https://api.exness.com`: gateway host shown in the Exness DNS widget
- Optional: `EXN_INSTRUMENT_XAUUSD=XAUUSD`
- Optional: `EXN_INSTRUMENT_BTCUSD=BTCUSD`

Store credentials only in Render environment variables. Never commit them to GitHub, place them in frontend code, or send them in chat. The gateway host is not the account Access Point: the backend discovers the Access Point before account-scoped requests.

## Data flow

1. Sign a read-only Access Point discovery request using Exness Ed25519 request signing.
2. Check `/v1/configuration/accounts/{account_id}/instruments` for the requested symbol.
3. Fetch candles from `/v1/market-data/accounts/{account_id}/candles`.
4. Open a signed WebSocket handshake at `/v1/server-events/accounts/{account_id}/ws/ticks`, subscribe to the instrument, and accept only a fresh positive bid/ask tick.
5. Return `LIVE` only after candles and a fresh tick both succeed. Otherwise return an offline error.

## Verify after deployment

- `/api/v1/health` confirms the API process is running; it does not prove live market data.
- `/api/v1/market/XAUUSD?timeframe=15m`
- `/api/v1/market/BTCUSD?timeframe=15m`

Check `status=LIVE`, provider `Exness Trader API`, positive bid/ask, `updated_at` within 180 seconds, and non-empty candles. Account-specific symbol access still needs a real credential test.

Supported timeframes in this branch: 5m, 15m, 30m, 1h, 4h. 45m aggregation is not implemented. No order placement is included. Runtime tests and an authenticated live quote still need verification after Render is configured.