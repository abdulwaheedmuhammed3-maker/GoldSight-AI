# TradeSight 2.0

A clean, local-first rebuild of TradeSight. This directory is an isolated V2 foundation; the existing application at the repository root is not modified by the V2 work.

## Product goals

- One trustworthy, timestamped price per instrument across market watch, instrument header, chart current-price marker and signal calculations.
- Keep the last valid price visible while refreshing or when a provider fails. Never clear a valid display just because a refresh started.
- Generate signals independently on Android. The Windows companion is optional and is used for MT5 account telemetry and additional desktop capabilities.
- Work offline with cached quotes, candles, signals, settings and journal records. Clearly distinguish cached data from live data.
- Use the Eduvia visual language as inspiration: white-first surfaces, expressive indigo/violet, blue, mint, lime and coral accents, soft rounded cards, Manrope/DM Sans typography, and a separately defined dark palette.
- Build genuinely responsive desktop and mobile layouts.

## Proposed stack

- UI: React, TypeScript and Vite.
- Android packaging: Capacitor.
- Local persistence: SQLite on device; browser IndexedDB for desktop/PWA where appropriate.
- On-device market-data and signal domain: TypeScript modules, independent of React components.
- Optional Windows companion: Python service for MT5 terminal integration, local-network API and heavier optional processing.
- Charts: TradingView Lightweight Charts, fed by the same canonical market-data store used by the rest of the UI.
- Tests: Vitest for frontend/domain modules; Pytest for the optional Windows companion.

No cloud host is required for the core application. Real-time external prices still require internet and an accessible market-data provider. MT5 account telemetry requires the Windows terminal to be running; core Android quotes and signal calculations must not depend on it.

## Non-negotiable market-data rules

Read **docs/live-price-consistency.md** before implementing any market screen, chart or signal consumer.

1. A single canonical quote snapshot is published per instrument.
2. Market watch, instrument detail, chart current-price line and signal evaluation read that same snapshot.
3. The current chart candle is updated from the same canonical tick stream and uses the same price basis.
4. A refresh never clears the current quote.
5. Only a validated newer quote can replace the previous valid quote.
6. A retained quote is visibly STALE or OFFLINE; it must never be labelled LIVE.
7. Do not invent, interpolate or fabricate market prices to fill gaps.
8. Never silently combine candles and ticks from incompatible providers or price bases.

## Build sequence

1. Domain contracts, local persistence and market-data state machine.
2. Provider adapters and canonical quote store.
3. Candle aggregation and chart synchronization.
4. Signal engine and historical replay.
5. Responsive UI and design system.
6. Android packaging, notifications and offline verification.
7. Optional Windows MT5 companion.
8. End-to-end and data-integrity audits.

## Run the V2 web app locally

From the repository root:

    cd v2
    npm install
    npm run dev

For verification:

    npm run typecheck
    npm test
    npm run build

For Android packaging, install Android Studio and the Android SDK, then:

    npm run cap:add:android
    npm run build
    npm run cap:sync:android

The web shell is designed to be installable as a PWA. The Android package still requires an Android build environment to produce an APK. After `npx cap add android`, run `npm run cap:android:prepare` before `npx cap sync android` to install the native TradeSight foreground monitoring service.

## Provider coverage

See docs/provider-matrix.md for the current live-feed scope, provider limitations, price-basis distinctions and remaining instruments. The current Free SiftingIO example allows a single connection and five symbols; the actual key acknowledgement is authoritative.

## Current status

The isolated V2 foundation now contains the local-first React app, canonical quote store, BTC spot stream, selectable shared Gold/FX stream, synchronized chart candle engine, IndexedDB quote/candle persistence, PWA shell, and automated CI. Signal generation, target notifications, complete instrument coverage, and the Windows MT5 companion are not yet complete.
