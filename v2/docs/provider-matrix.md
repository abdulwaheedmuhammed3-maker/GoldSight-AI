# TradeSight 2.0 Provider Matrix

**This is the current implementation scope, not a promise that every instrument is already live.**

| Instrument | Current adapter | Source basis | Notes |
|---|---|---|---|
| BTCUSD | Binance Spot WebSocket (BTCUSDT) | Last trade | Public stream; spot price can differ from a broker CFD. |
| XAUUSD | SiftingIO WebSocket | Provider last/reference price | User supplies a dedicated SiftingIO market-data API key. |
| EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, NZDUSD, EURGBP | SiftingIO WebSocket | Provider last/reference price | Shared FX product channel; only selected symbols are subscribed. |
| USDNGN | Not connected in V2 yet | — | Must be verified against an approved source before it can be labelled live. |

## SiftingIO subscription model

The adapter shares one WebSocket connection across selected Forex and Commodities symbols. SiftingIO offers a separate Free tier for each market, each with one connection and up to five symbol subscriptions; using Forex does not consume the Commodities allowance, and vice versa. The provider's authentication acknowledgement is still checked, and subscription errors are shown per product. See the [pricing page](https://sifting.io/pricing) and [WebSocket protocol](https://sifting.io/docs/websocket).

Use the dedicated key only for market data. The browser WebSocket protocol requires the key in the connection URL, which can appear in developer tools and connection diagnostics. The key is held in memory by the current adapter instance and is not stored in IndexedDB or localStorage. Feed instrument selection is saved locally, but the key must be re-entered after an app restart.

## Price matching and price basis

- All visible TradeSight prices for a given instrument and selected provider read from that instrument's single canonical quote snapshot.
- The chart's active candle and current-price marker are updated by the same accepted tick as the watchlist.
- Binance BTCUSD is mapped to BTCUSDT spot. It is not the same contract as an Exness BTCUSD CFD.
- SiftingIO XAUUSD is an aggregated commodity spot reference, not guaranteed to match an individual broker's XAUUSD CFD quote.
- If the user requires exact broker-price matching, TradeSight must use that broker's own supported feed and price basis for both candles and ticks. The optional Windows MT5 companion can provide read-only broker telemetry while Windows MT5 is running; it is not required for Android's independent core.
- TradeSight never fabricates or interpolates a live quote to fill a provider gap.

## Freshness behaviour

LIVE is set only when a validated tick is within the instrument/provider freshness threshold. STALE and OFFLINE retain the last valid value and its original timestamp. A socket connection without a fresh tick is not enough to call a quote LIVE.

## Not yet implemented

Additional providers, all-instrument subscription orchestration, broker-specific quote alignment, signal generation, TP/SL notifications, demo trading, and Windows MT5 pairing are separate implementation stages. The first V2 slice currently covers the local data layer, BTC stream, selectable Gold/FX stream, candle synchronization, and cached quote/candle persistence.
