# TradeSight 2.0 Provider Matrix

**This describes the source actually used per quote. A visible snapshot is not represented as a live tick stream.**

| Instrument | Provider | Primary source | Coverage |
|---|---|---|---|
| BTCUSD | Binance Spot (BTCUSDT) | Public WebSocket; REST ticker fallback if WebSocket is unavailable | Automatic, no API key |
| XAUUSD, XAGUSD, XPTUSD, XPDUSD, WTIUSD, UKOUSD, NATGAS | SiftingIO Market Data | Commodity WebSocket when selected and accepted by the live subscription cap; selected overflow uses timestamped REST top-of-book snapshots | User supplies a dedicated SiftingIO market-data API key |
| EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, NZDUSD, EURGBP | SiftingIO Market Data | Selected pairs use WebSocket; remaining pairs use a batched Forex REST snapshot | User supplies a dedicated SiftingIO API key |
| USDNGN | Not connected in V2 yet | — | Needs a separately verified, permitted market-data source |

## SiftingIO free-tier routing

TradeSight lets the user mark up to five Forex pairs and five Commodities instruments as local streaming priorities. The WebSocket authentication acknowledgement reports `max_subs`, which is the total subscription allowance for the single connection across all product batches (see the [SiftingIO WebSocket protocol](https://sifting.io/docs/websocket)). TradeSight preserves the selected-symbol order and allocates that shared allowance across commodities and FX; symbols after the account limit use REST snapshots. With the default order (XAUUSD first, followed by five FX pairs) and a five-subscription allowance, XAUUSD and the first four FX pairs stream, while the fifth FX pair uses REST snapshots.

REST snapshots refresh every six minutes while the app is active. One batched Forex request every six minutes is approximately 7,200 calls over 30 days, below the published 10,000 REST-call monthly free allowance and leaving some headroom for history requests. Actual usage depends on how long TradeSight stays open and the number of historical requests. The provider's authentication acknowledgement and account entitlements remain authoritative.

Snapshot prices are lower-frequency reference updates, not tick-by-tick streaming. TradeSight labels them **SNAPSHOT**, does not use them to generate live trade signals, and does not use them to trigger TP/SL outcome alerts. SiftingIO also sends one cached reference frame for each newly subscribed WebSocket symbol before live updates begin; TradeSight classifies that first frame as **WEBSOCKET SNAPSHOT** and applies the same exclusions. Only subsequent validated stream frames are eligible for live candles, signal scans and outcome monitoring.

See the [SiftingIO pricing page](https://sifting.io/pricing), [WebSocket protocol](https://sifting.io/docs/websocket), [Forex snapshot endpoint](https://sifting.io/docs/rest/market-snapshot), and [single-quote endpoint](https://sifting.io/docs/rest/last-quote).

## Credentials and usage restrictions

Use a dedicated, revocable market-data key only. The browser WebSocket protocol requires the key in the connection URL, which can appear in developer tools and connection diagnostics. In the Android app, users can opt to remember the key; it is encrypted with an AES-GCM key held by Android Keystore and automatically restored on app launch. The encrypted value is stored in private app preferences, not in plaintext localStorage or IndexedDB. Disconnect removes the remembered credential. Browser/PWA sessions remain memory-only and require the key to be re-entered after a restart.

The free tier is intended for individual internal, non-commercial use. It does not license one shared key for public customer-facing market-data redistribution. Each permitted user must connect their own key.

## Exness symbol matching

The commodity picker includes a broker-name cross-reference:

| TradeSight / SiftingIO reference | Exness MT5 symbol | Instrument |
|---|---|---|
| XAGUSD | XAGUSD | Silver |
| XPTUSD | XPTUSD | Platinum |
| XPDUSD | XPDUSD | Palladium |
| WTIUSD | USOIL | WTI crude oil |
| UKOUSD | UKOIL | Brent crude oil |
| NATGAS | XNGUSD | Natural gas |

These are not broker execution feeds. SiftingIO publishes aggregated spot/reference prices; the underlying series, contract terms, trading hours and prices can differ from Exness CFDs. Keep the SiftingIO reference price and MT5 execution price distinct in decisions and journals.

## Price matching and price basis

- Each instrument has one canonical quote snapshot used by the watchlist, chart and signal surfaces.
- WebSocket quotes retain their provider price basis; unstreamed XAUUSD REST snapshots use the explicit bid/ask midpoint basis.
- Binance BTCUSD maps to BTCUSDT spot; it is not the same contract as a broker BTCUSD CFD.
- SiftingIO XAUUSD is a commodity reference, not guaranteed to match an individual broker's XAUUSD CFD.
- If exact broker-price matching is required, the app needs that broker's supported feed and consistent price basis for quotes and candles.
- TradeSight never fabricates or interpolates a price to fill a provider gap.

## Freshness

A WebSocket quote can be labelled LIVE only while its validated source timestamp is within the instrument's freshness threshold. REST and initial WebSocket subscription snapshots are shown as SNAPSHOT and are never promoted to LIVE. Old snapshots become STALE or OFFLINE and retain their original timestamp.
