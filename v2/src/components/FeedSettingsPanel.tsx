import { useEffect, useState } from "react";
import { marketEngine } from "../domain/market-data/runtime";
import { SiftingIoAdapter } from "../domain/market-data/siftingio-adapter";
import { isSnapshotQuote } from "../domain/market-data/types";
import { useInstrumentMarketState } from "../hooks/use-market-data";
import {
  announceFeedSelectionChanged,
  FEED_SELECTION_STORAGE_KEY,
} from "../domain/market-data/feed-preferences";

const FEED_SYMBOLS = [
  { symbol: "XAUUSD", label: "Gold", market: "commodities" },
  { symbol: "EURUSD", label: "EUR / USD", market: "forex" },
  { symbol: "GBPUSD", label: "GBP / USD", market: "forex" },
  { symbol: "USDJPY", label: "USD / JPY", market: "forex" },
  { symbol: "AUDUSD", label: "AUD / USD", market: "forex" },
  { symbol: "USDCAD", label: "USD / CAD", market: "forex" },
  { symbol: "USDCHF", label: "USD / CHF", market: "forex" },
  { symbol: "NZDUSD", label: "NZD / USD", market: "forex" },
  { symbol: "EURGBP", label: "EUR / GBP", market: "forex" },
] as const;

type FeedSymbol = (typeof FEED_SYMBOLS)[number]["symbol"];
type FeedMarket = "forex" | "commodities";

const DEFAULT_SELECTED_SYMBOLS: FeedSymbol[] = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD"];

function loadSavedSelection(): FeedSymbol[] {
  if (typeof localStorage === "undefined") return DEFAULT_SELECTED_SYMBOLS;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FEED_SELECTION_STORAGE_KEY) ?? "null");
    if (!Array.isArray(value)) return DEFAULT_SELECTED_SYMBOLS;
    const selected = value.filter((symbol): symbol is FeedSymbol =>
      typeof symbol === "string" && FEED_SYMBOLS.some((item) => item.symbol === symbol),
    );
    const forexCount = selected.filter((symbol) => FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "forex").length;
    const commoditiesCount = selected.filter((symbol) => FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "commodities").length;
    return forexCount <= 5 && commoditiesCount <= 5 ? selected : DEFAULT_SELECTED_SYMBOLS;
  } catch {
    return DEFAULT_SELECTED_SYMBOLS;
  }
}

function formatPrice(price: number, digits: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(price);
}

function FeedInstrumentStatus({ symbol, label }: { symbol: FeedSymbol; label: string }) {
  const state = useInstrumentMarketState(symbol);
  const quote = state.quote.quote;
  const snapshotFresh = isSnapshotQuote(quote) &&
    (state.quote.quoteAgeMs ?? Number.POSITIVE_INFINITY) <= 7 * 60_000;
  const displayedStatus = snapshotFresh ? "SNAPSHOT" : state.quote.freshness;

  return (
    <div className="feed-status-row">
      <div>
        <strong>{symbol} · {label}</strong>
        <span>{quote ? formatPrice(quote.price, quote.digits) : "Waiting for first valid quote"}</span>
        <small>
          {quote
            ? (state.detail ?? quote.provider) + " · " + new Date(quote.sourceTimeMs).toLocaleTimeString()
            : state.detail ?? (
              state.feedStatus === "CONNECTING"
                ? "Connecting to provider..."
                : state.feedStatus === "ERROR"
                  ? "Provider connection error"
                  : "Not connected · enter key and connect"
            )}
        </small>
      </div>
      <span className={"feed-state feed-" + displayedStatus.toLowerCase()}>
        {state.feedStatus === "CONNECTED" ? displayedStatus : state.feedStatus}
      </span>
    </div>
  );
}

export default function FeedSettingsPanel() {
  const [apiKey, setApiKey] = useState("");
  const [selectedSymbols, setSelectedSymbols] = useState<FeedSymbol[]>(loadSavedSelection);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(FEED_SELECTION_STORAGE_KEY, JSON.stringify(selectedSymbols));
      announceFeedSelectionChanged();
    } catch {
      setMessage("Instrument preferences could not be saved on this device.");
    }
  }, [selectedSymbols]);

  const toggleSymbol = (symbol: FeedSymbol) => {
    if (selectedSymbols.includes(symbol)) {
      setSelectedSymbols((current) => current.filter((item) => item !== symbol));
      return;
    }
    const market = FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market as FeedMarket | undefined;
    const selectedInMarket = selectedSymbols.filter((selected) =>
      FEED_SYMBOLS.find((item) => item.symbol === selected)?.market === market,
    ).length;
    if (selectedInMarket >= 5) {
      setMessage(
        market === "commodities"
          ? "The SiftingIO free Commodities tier allows up to five commodity subscriptions."
          : "The SiftingIO free Forex tier allows up to five FX-pair subscriptions.",
      );
      return;
    }
    setSelectedSymbols((current) => [...current, symbol]);
    setMessage(null);
  };

  const connectSelected = () => {
    const key = apiKey.trim();
    if (!key) {
      setMessage("Enter your SiftingIO market-data API key.");
      return;
    }
    const forexCount = selectedSymbols.filter((symbol) =>
      FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "forex",
    ).length;
    const commoditiesCount = selectedSymbols.filter((symbol) =>
      FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "commodities",
    ).length;
    if (forexCount > 5 || commoditiesCount > 5) {
      setMessage("The SiftingIO free allowance is five subscriptions per market. Reduce the Forex or Commodities selection.");
      return;
    }

    setBusy(true);
    try {
      marketEngine.unregisterAdapter("SiftingIO Market Data");
      const adapter = new SiftingIoAdapter(key, selectedSymbols);
      marketEngine.registerAdapter(adapter);
      // Selected pairs receive the high-frequency WebSocket stream. Every
      // remaining supported instrument is still populated by REST snapshots.
      for (const { symbol } of FEED_SYMBOLS) {
        marketEngine.connect(symbol, adapter.providerId);
      }
      setApiKey("");
      const streamingFx = selectedSymbols.filter((symbol) =>
        FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "forex",
      ).length;
      const streamingCommodities = selectedSymbols.filter((symbol) =>
        FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "commodities",
      ).length;
      setMessage(
        "Connected all supported instruments. WebSocket streaming: " +
        streamingFx + " Forex and " + streamingCommodities +
        " Commodities. Other instruments use timestamp-checked REST snapshots refreshed about every 6 minutes.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start the market-data feed.");
    } finally {
      setBusy(false);
    }
  };

  const disconnectFeeds = () => {
    marketEngine.unregisterAdapter("SiftingIO Market Data");
    setMessage("SiftingIO disconnected. Last accepted prices remain visible as OFFLINE.");
  };

  return (
    <section className="surface feed-settings-panel">
      <div className="surface-heading">
        <div>
          <span className="card-kicker">DIRECT MARKET FEEDS</span>
          <h2>Gold and Forex connections</h2>
          <p>All supported prices can populate from one personal SiftingIO key. Selected instruments stream live; the rest use timestamped snapshots.</p>
        </div>
        <span className="chart-state">SESSION KEY</span>
      </div>

      <div className="feed-instrument-picker">
        <div className="feed-picker-heading">
          <strong>High-frequency WebSocket streams</strong>
          <span>
            Forex {selectedSymbols.filter((symbol) => FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "forex").length}/5
            {" · "}
            Commodities {selectedSymbols.filter((symbol) => FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "commodities").length}/5
          </span>
        </div>
        <div className="feed-symbol-grid">
          {FEED_SYMBOLS.map(({ symbol, label, market }) => (
            <label className={"feed-symbol-option " + (selectedSymbols.includes(symbol) ? "selected" : "")} key={symbol}>
              <input
                type="checkbox"
                checked={selectedSymbols.includes(symbol)}
                disabled={
                  !selectedSymbols.includes(symbol) &&
                  selectedSymbols.filter((selected) =>
                    FEED_SYMBOLS.some((item) => item.symbol === selected && item.market === market),
                  ).length >= 5
                }
                onChange={() => toggleSymbol(symbol)}
              />
              <span><strong>{symbol}</strong><small>{label}</small></span>
            </label>
          ))}
        </div>
        <p className="feed-plan-note">Choose up to five Forex pairs and five Commodities instruments for tick-by-tick WebSocket streaming. Every other supported instrument still receives a timestamp-checked REST snapshot about every 6 minutes; all remaining FX pairs share one batched request. Continuous use is about 7,200 calls per market per 30 days, within the published 10,000-call free allowance, with some headroom for history requests. Snapshot prices are lower-frequency references, not live ticks, and are excluded from trade signals and TP/SL alerts. The free tier is for individual internal, non-commercial use and does not license shared customer-facing market-data redistribution.</p>
      </div>

      <label className="feed-key-label" htmlFor="sifting-api-key">SiftingIO API key</label>
      <div className="feed-key-row">
        <input
          id="sifting-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="Paste a dedicated market-data key"
        />
        <button className="primary-btn" type="button" onClick={connectSelected} disabled={busy || !apiKey.trim()}>
          {busy ? "Connecting..." : "Connect all feeds"}
        </button>
      </div>
      <button className="text-btn feed-disconnect" type="button" onClick={disconnectFeeds}>
        Disconnect SiftingIO feeds
      </button>

      {message ? <div className="feed-message" role="status">{message}</div> : null}

      <div className="feed-connected-list">
        {FEED_SYMBOLS.map(({ symbol, label }) => (
          <FeedInstrumentStatus key={symbol} symbol={symbol} label={label} />
        ))}
      </div>

      <div className="feed-security-note">
        <strong>Free-tier and credential handling</strong>
        <p>The key is held only in the active app session and is not saved to IndexedDB or localStorage. After closing or restarting TradeSight, enter the key again and press Connect selected. SiftingIO requires the key in the WebSocket connection URL, so it may be visible in browser developer tools or connection diagnostics. Use a dedicated, revocable market-data key only. Each user must use their own key for their own permitted use; do not embed a shared key in the public website. Never enter a broker password, Exness private key or account login here.</p>
      </div>
    </section>
  );
}
