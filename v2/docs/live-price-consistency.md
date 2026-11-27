# Live Price Consistency Contract

**Status:** Required architecture contract for TradeSight 2.0  
**Scope:** Every supported instrument, data provider, chart, market-watch row, signal calculation and price-dependent notification.

## 1. The core guarantee

For one instrument and one selected feed, every part of TradeSight must consume the same canonical quote snapshot.

If the canonical snapshot for XAUUSD is updated to price P at source time T, then the following must display P and T from that same snapshot:

- Market Watch current price.
- Instrument detail current price.
- Chart live-price marker and active-candle close.
- Signal engine current-market reference.
- Price shown in any open-trade or setup monitor that refers to the current market.

Components must not fetch their own current price independently. They subscribe to the shared QuoteStore.

This gives exact consistency **inside TradeSight**. It cannot make independent exchanges, brokers or third-party providers publish ticks at the same instant. Each instrument therefore retains its own source timestamp and receipt timestamp.

## 2. Canonical quote shape

Every accepted tick is normalized to this contract (additional provider metadata is allowed):

- instrumentId: TradeSight stable instrument ID.
- provider: exact source that supplied this quote.
- providerSymbol: exact symbol at that provider.
- priceBasis: one of last, bid, mid or mark.
- price: canonical display/chart price.
- bid, ask, last: separate optional quote values.
- sourceTimeMs: provider event time, UTC epoch milliseconds.
- receivedTimeMs: time TradeSight received the event, UTC epoch milliseconds.
- sequence: provider sequence number, when available.
- digits: provider-defined display precision.

The provider adapter selects and documents one price basis for each instrument/provider combination. Every current-price surface uses price; bid and ask remain separately labelled values. Do not show a midpoint in one component and a bid/last in another while calling both simply current price.

A broker CFD/FX chart may use bid-based bars, while an exchange-traded crypto chart may use last-trade bars. The selected basis must be explicit in the adapter and consistent across the instrument quote, live candle and current-price marker.

## 3. One quote store, one update path

Required flow:

Provider WebSocket or approved streaming feed
→ Provider adapter
→ Normalize and validate
→ Ordered tick gate
→ Canonical QuoteStore per instrument
→ Local persistence and candle aggregator
→ Shared subscriptions
→ Watch, detail, chart and signals

- React components never fetch quotes on mount.
- Opening an instrument subscribes to cached state immediately; it does not blank the page while requesting a refresh.
- A provider event updates the QuoteStore once. All subscribers receive the same immutable snapshot/version.
- Publish the UI state only after the new quote has passed validation and the store's atomic update policy.
- A reconnect must hydrate the last stored snapshot before the next network refresh.

## 4. Validation and ordering

Reject an incoming quote if any required field is invalid:

- Price is not numeric, finite and strictly positive.
- Source timestamp is missing, malformed, implausibly future-dated or outside the provider-specific acceptance window.
- Bid/ask are malformed, or ask is below bid, when bid/ask are supplied.
- Provider symbol does not map to the requested TradeSight instrument.
- The event is older than the currently accepted event, according to provider sequence when supplied and otherwise source timestamp.
- The provider marks the event as invalid/corrected in a way the adapter does not support.

A rejected quote must never replace or delete the last valid quote. Duplicate/out-of-order events are counted in diagnostics. Provider-specific timestamp and tick-order semantics must be tested; do not assume all providers expose a sequence number.

## 5. Last-known-good persistence and no-blank refresh

The quote lifecycle must not use a loading state that sets the displayed price to null.

- Keep lastKnownGoodQuote in memory and persist it locally.
- Start refreshes in the background while continuing to render the existing price.
- On a valid newer event, atomically replace the stored snapshot and notify subscribers.
- On timeout, disconnect, malformed response or provider error, preserve the last accepted quote.
- On cold start, hydrate the last accepted quote from local storage before requesting fresh data.
- If there has never been a valid quote, show an explicit state such as **Waiting for first valid quote**. Do not show a dash, zero, made-up value or a false LIVE badge.
- Never clear a quote merely because the instrument detail page is opened, a chart is loading, a provider is retrying or the network has briefly disconnected.

## 6. Honest freshness states

Freshness is calculated from source time and provider-specific limits, not from the time the browser last repainted.

- **LIVE:** a validated quote is within the freshness threshold configured for that instrument/provider.
- **STALE:** a previous valid quote is retained, but its source timestamp is outside the live threshold.
- **OFFLINE:** no fresh provider connection/quote is currently available. A previous price may still be displayed with its timestamp.
- **WAITING:** no valid quote has ever been received or restored.

Always preserve and show the source time or age. A successful HTTP request or an open socket alone does not mean the instrument's price is LIVE. Market-closed instruments must not be labelled live simply because a connection is online.

Freshness thresholds must be configurable by provider and instrument. Crypto, FX, metals, equities and closed sessions have different event patterns; a single global threshold can misclassify valid feeds.

## 7. Chart and candle synchronization

The chart must not use an unrelated current-price endpoint.

- Historical candles and the live tick stream must come from the same provider and price basis, or from a source pair explicitly certified as compatible.
- The active candle is updated from the same canonical tick used by the market-watch price.
- For a tick with canonical price P, the active candle close becomes P; its high/low are updated using P. The chart current-price marker also becomes P.
- Candle timestamps are UTC epoch milliseconds internally and are aligned to the requested timeframe.
- Completed candle history may be fetched on initial load, but provider, symbol, timezone, price basis and timeframe alignment must be checked before merging it with locally aggregated candles.
- Never silently merge broker candles with an indicative spot feed or an exchange price from a different market.
- When the selected provider changes, mark the source transition. Rebuild/reload the affected candle history from the newly selected provider before presenting a continuous series; do not silently splice incomparable prices.

## 8. Time and display precision

- Store source time and receipt time in UTC epoch milliseconds.
- Display timestamps in the user's local timezone, but never change the underlying candle or event timestamp.
- All price surfaces for one instrument render from the same quote version and the same precision metadata.
- Do not round the stored price for calculations. Apply provider-defined display digits only at presentation time.
- A fresh tick must update all visible surfaces from one store event; do not let individual components use separate polling timers.
- Expose source-to-device latency and quote age separately in diagnostics. UI animation/render cadence is not the same as provider tick cadence.

## 9. Provider fallback policy

A fallback provider must never silently overwrite the active feed while retaining the old source label.

A provider switch must:
1. Be recorded in the instrument source state and diagnostics.
2. Set the new provider and price basis explicitly.
3. Load compatible history for the new provider.
4. Establish the new canonical stream.
5. Mark any chart source boundary when comparing history across providers.
6. Keep the prior quote visible as STALE/OFFLINE until a validated new-provider quote arrives.

No synthetic or interpolated quote may be created to disguise a provider outage. A fallback may be used only when its source and price basis are disclosed and it has passed instrument-specific compatibility tests.

## 10. Signal and target monitoring

Signal generation and TP/SL monitoring must consume the same timestamped canonical quote or same-source candles. The reference price used when a setup is created must be stored with its provider, price basis and source timestamp.

A signal cannot be evaluated from a stale quote as though it were live. When data is stale or unavailable, pause live outcome transitions and record the data-quality reason. Historical replay may use verified historical candles, but must be clearly distinguished from live monitoring.

## 11. Required automated tests

The following tests are release blockers:

1. **Same-snapshot equality:** after a quote update, Market Watch, detail page, chart marker and signal reference show the same canonical price and quote version.
2. **Active candle equality:** the current candle close and chart current-price marker equal the latest canonical price for the selected basis.
3. **No-blank refresh:** initiating refresh does not clear the last accepted price.
4. **Provider failure retention:** timeout, disconnect and malformed response leave the last good quote intact and mark freshness honestly.
5. **Cold-start retention:** after app restart, cached last good prices are shown before network refresh completes.
6. **Out-of-order protection:** an older tick cannot replace a newer accepted tick.
7. **Provider boundary:** quotes/candles from incompatible sources or price bases are never silently merged.
8. **Precision consistency:** all current-price surfaces apply identical display precision.
9. **Truthful LIVE status:** connection-open without a fresh tick does not produce LIVE.
10. **Multi-instrument isolation:** one instrument provider failure cannot erase or change another instrument cached quote.

## 12. What this contract does not promise

TradeSight can guarantee that its own screens use one canonical quote snapshot and that its chart is built consistently from that source. It cannot guarantee that an upstream provider emits a new tick every second, that every asset has a free real-time feed, or that unrelated brokers show identical prices. Provider latency, market session, spread and instrument contract specifications remain real-world constraints.

The product must communicate those constraints honestly rather than fabricate prices or label cached data as live.
