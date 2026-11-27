# TradeSight 2.0 System Architecture

## Operating model

TradeSight is Android-first and desktop-capable, local-first, and does not require Render, Railway or a hosted database for core use.

### Android (independent core)

- React + TypeScript application packaged with Capacitor.
- TypeScript market-data adapters connect to supported feeds when internet is available.
- Domain engine runs on the device; signal generation does not require the Windows PC.
- SQLite stores quotes, OHLC candles, signals, watchlists, journals, settings and notification events.
- Cached information remains available without internet.
- Native Android notification and background capabilities are used within platform limits; persistent background live-feed monitoring must be explicitly tested against Android OS process and battery policies.

### Desktop

- Responsive web/PWA layout using the same domain and UI packages.
- Browser IndexedDB for local browser data where the app is not installed as a desktop shell.
- Optional Windows companion may expose a local-only authenticated endpoint for MT5 integration and additional processing.

### Optional Windows companion

- Python service attached to the user's running MT5 terminal.
- Provides broker/account telemetry and optional local-market feed access.
- It is not the source of truth for Android market prices when Windows is shut down.
- Local-network pairing must use short-lived/revocable device credentials, TLS where feasible, and least-privilege read-only MT5 permissions by default.
- Core Android quote collection and signal generation must continue without this companion.

## Shared domain packages

- domain/instruments: stable instrument IDs, provider symbol mappings, market sessions, digits and supported timeframes.
- domain/market-data: provider adapter interfaces, canonical quote schema, ordering/validation, freshness state, QuoteStore and local persistence.
- domain/candles: source-compatible history, UTC timeframe alignment and live tick-to-OHLC aggregation.
- domain/signals: multi-timeframe structure, liquidity, BOS/CHoCH, risk/reward, invalidation and signal audit events.
- domain/outcomes: TP1/TP2/TP3/SL progression with deduplication and event timestamps.
- domain/notifications: local notification scheduling, event deduplication, preferences and notification history.
- ui/design-system: Eduvia-inspired tokens, typography, cards, buttons, badges, navigation, charts and responsive layouts.

## Market-data provider interface

Each provider adapter must declare:

- Instruments and provider symbols it supports.
- Whether the feed is streaming or polling.
- Price basis (last, bid, mid or mark).
- Source timestamp and optional sequence semantics.
- Quote precision/digits.
- Compatible historical candle endpoint and timeframe support.
- Market-session behaviour, freshness policy and known delay.
- Whether credentials are required and how the user supplies them securely.

Do not select a provider solely because its API is free. Verify price type, latency, historical OHLC support, market coverage, licensing/terms, rate limits and availability on Android first.

## Data ownership

- UI components consume read-only stores and never own quote-fetching logic.
- One instrument has one active canonical source at a time.
- Local persistent state is authoritative for offline display.
- Provider responses are untrusted until normalized and validated.
- Live data is never synthesized from stale snapshots.
- Each signal and outcome record stores the quote/candle source and event time used for its decision.

## Quality gates

No screen is complete until:
- It works at mobile, tablet and desktop widths.
- Light and dark themes pass visual contrast checks independently.
- It reads market values from domain stores rather than hardcoded sample values.
- It keeps last-known-good state during background refresh.
- Its price display has a source timestamp and truthful freshness label.
- Its integration tests confirm chart/watch/detail quote equality.
