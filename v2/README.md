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
- Local persistence: IndexedDB in the browser, PWA and Capacitor Android WebView. No hosted database is required.
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

The web shell is designed to be installable as a PWA. The Android package is built by the free GitHub Actions workflow for this public repository. After `npx cap add android`, run `npm run cap:android:prepare` before `npx cap sync android` to install the native TradeSight foreground monitoring service.

## Free website hosting

The public website is deployed as static assets to Cloudflare Workers. Read **docs/cloudflare-deployment.md** for the one-time API-token setup. The production pipeline uses the Cloudflare CLI and does not use Render, Railway, GitHub Pages or a hosted application server. Static asset delivery is the only Cloudflare capability used by this frontend; server-side Functions and databases are not enabled.

## Provider coverage

See docs/provider-matrix.md for the current live-feed scope, provider limitations, price-basis distinctions and remaining instruments. SiftingIO supports Forex and commodities through one credential and a shared WebSocket connection. TradeSight's selector includes Gold, Silver, Platinum, Palladium, Aluminium, Copper, Nickel, Lead, Zinc, WTI Crude, Brent Crude and Natural Gas in addition to supported Forex pairs. Only checked instruments are connected. The free tier documents one WebSocket connection, five symbol subscriptions and 10,000 REST calls per month; the provider's auth acknowledgement is authoritative. Selected symbols beyond the live subscription limit may receive REST snapshots, labelled SNAPSHOT rather than LIVE; snapshots never trigger signal scans or TP/SL alerts. Unchecked catalogue instruments are not polled. The provider's authentication acknowledgement and current terms remain authoritative. Free-tier use is restricted to individual internal, non-commercial use; each user must connect a permitted personal key. Do not expose or redistribute a shared key.

## Android background monitoring

Read docs/android-background-monitoring.md for foreground-service limits, setup steps and required screen-off acceptance tests.

## Current status

The isolated V2 foundation contains the responsive React app, canonical quote store, BTC spot stream, selectable Gold/FX stream, synchronized chart candle engine, IndexedDB persistence for quotes/candles/outcomes, multi-timeframe signal engine and scanner, TP/SL outcome monitoring, notification controls, PWA shell, Cloudflare static deployment workflow, and Android foreground-monitoring integration. The deployment pipeline needs the maintainer's one-time Cloudflare API token secret. Provider coverage and background reliability still require device/provider acceptance tests; the optional Windows MT5 companion remains to be built.


## Trade journal and portfolio

The Journal lets you manually record completed BUY/SELL trades with entry, exit, stop-loss, timeframe, open/close times and notes. It validates stop placement and calculates the result as an R-multiple, then stores the record in a separate local IndexedDB store. Portfolio statistics are derived only from those journal records; they are not broker balance, equity or cash P&L. Journal data stays in the current browser or Android app installation and is not synced across devices.
