import { useState } from "react";
import { marketEngine } from "../domain/market-data/runtime";
import { SiftingIoAdapter } from "../domain/market-data/siftingio-adapter";
import { useInstrumentMarketState } from "../hooks/use-market-data";

const FEED_SYMBOLS = [
  { symbol: "XAUUSD", label: "Gold" },
  { symbol: "EURUSD", label: "EUR / USD" },
  { symbol: "GBPUSD", label: "GBP / USD" },
  { symbol: "USDJPY", label: "USD / JPY" },
  { symbol: "AUDUSD", label: "AUD / USD" },
  { symbol: "USDCAD", label: "USD / CAD" },
  { symbol: "USDCHF", label: "USD / CHF" },
  { symbol: "NZDUSD", label: "NZD / USD" },
  { symbol: "EURGBP", label: "EUR / GBP" },
] as const;

type FeedSymbol = (typeof FEED_SYMBOLS)[number]["symbol"];

function formatPrice(price: number, digits: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(price);
}

function FeedInstrumentStatus({ symbol, label }: { symbol: FeedSymbol; label: string }) {
  const state = useInstrumentMarketState(symbol);
  const quote = state.quote.quote;
  const freshness = state.quote.freshness.toLowerCase();

  return (
    <div className="feed-status-row">
      <div>
        <strong>{symbol} · {label}</strong>
        <span>{quote ? formatPrice(quote.price, quote.digits) : "Waiting for first valid quote"}</span>
        <small>
          {quote
            ? quote.provider + " · " + new Date(quote.sourceTimeMs).toLocaleTimeString()
            : state.detail ?? "No valid quote received yet"}
        </small>
      </div>
      <span className={"feed-state feed-" + state.feedStatus.toLowerCase()}>
        {state.feedStatus === "CONNECTED" ? state.quote.freshness : state.feedStatus}
      </span>
    </div>
  );
}

export default function FeedSettingsPanel() {
  const [apiKey, setApiKey] = useState("");
  const [selectedSymbols, setSelectedSymbols] = useState<FeedSymbol[]>(["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD"]);
  const [connectedSymbols, setConnectedSymbols] = useState<FeedSymbol[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleSymbol = (symbol: FeedSymbol) => {
    setSelectedSymbols((current) => current.includes(symbol)
      ? current.filter((item) => item !== symbol)
      : [...current, symbol]);
  };

  const connectSelected = () => {
    const key = apiKey.trim();
    if (!key) {
      setMessage("Enter your SiftingIO market-data API key.");
      return;
    }
    if (selectedSymbols.length === 0) {
      setMessage("Select at least one instrument to connect.");
      return;
    }

    setBusy(true);
    try {
      marketEngine.unregisterAdapter("SiftingIO WebSocket");
      const adapter = new SiftingIoAdapter(key);
      marketEngine.registerAdapter(adapter);
      for (const symbol of selectedSymbols) {
        marketEngine.connect(symbol, adapter.providerId);
      }
      setConnectedSymbols(selectedSymbols);
      setApiKey("");
      setMessage("One shared SiftingIO connection requested for " + selectedSymbols.length + " symbols. The provider's authentication acknowledgement determines the actual subscription capacity.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start the market-data feed.");
    } finally {
      setBusy(false);
    }
  };

  const disconnectFeeds = () => {
    marketEngine.unregisterAdapter("SiftingIO WebSocket");
    setConnectedSymbols([]);
    setMessage("SiftingIO disconnected. Last accepted prices remain visible as OFFLINE.");
  };

  return (
    <section className="surface feed-settings-panel">
      <div className="surface-heading">
        <div>
          <span className="card-kicker">DIRECT MARKET FEEDS</span>
          <h2>Gold and Forex connections</h2>
          <p>One SiftingIO WebSocket connection can carry multiple supported instruments. Windows is not required.</p>
        </div>
        <span className="chart-state">SESSION KEY</span>
      </div>

      <div className="feed-instrument-picker">
        <div className="feed-picker-heading">
          <strong>Select instruments</strong>
          <span>{selectedSymbols.length} selected</span>
        </div>
        <div className="feed-symbol-grid">
          {FEED_SYMBOLS.map(({ symbol, label }) => (
            <label className={"feed-symbol-option " + (selectedSymbols.includes(symbol) ? "selected" : "")} key={symbol}>
              <input
                type="checkbox"
                checked={selectedSymbols.includes(symbol)}
                onChange={() => toggleSymbol(symbol)}
              />
              <span><strong>{symbol}</strong><small>{label}</small></span>
            </label>
          ))}
        </div>
        <p className="feed-plan-note">SiftingIO reports your actual symbol-subscription capacity after authentication. Its documented Free tier currently lists up to five symbols per connection; higher capacity depends on the account plan.</p>
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
        <button className="primary-btn" type="button" onClick={connectSelected} disabled={busy || !apiKey.trim() || selectedSymbols.length === 0}>
          {busy ? "Connecting..." : "Connect selected"}
        </button>
      </div>
      <button className="text-btn feed-disconnect" type="button" onClick={disconnectFeeds}>
        Disconnect SiftingIO feeds
      </button>

      {message ? <div className="feed-message" role="status">{message}</div> : null}

      {connectedSymbols.length > 0 ? (
        <div className="feed-connected-list">
          {FEED_SYMBOLS.filter(({ symbol }) => connectedSymbols.includes(symbol)).map(({ symbol, label }) => (
            <FeedInstrumentStatus key={symbol} symbol={symbol} label={label} />
          ))}
        </div>
      ) : null}

      <div className="feed-security-note">
        <strong>Credential handling</strong>
        <p>The key is held only in the adapter's runtime memory and is not saved to IndexedDB or localStorage. SiftingIO requires the key in the WebSocket connection URL, so it may be visible in browser developer tools or connection diagnostics. Use a dedicated, revocable market-data key only. Never enter a broker password, Exness private key or account login here.</p>
      </div>
    </section>
  );
}
