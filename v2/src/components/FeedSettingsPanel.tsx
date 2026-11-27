import { useState } from "react";
import { marketEngine } from "../domain/market-data/runtime";
import { SiftingIoAdapter } from "../domain/market-data/siftingio-adapter";
import { useInstrumentMarketState } from "../hooks/use-market-data";

function formatPrice(price: number, digits: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(price);
}

export default function FeedSettingsPanel() {
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gold = useInstrumentMarketState("XAUUSD");
  const quote = gold.quote.quote;

  const connectGold = () => {
    const key = apiKey.trim();
    if (!key) {
      setMessage("Enter your SiftingIO market-data API key.");
      return;
    }
    setBusy(true);
    try {
      marketEngine.registerAdapter(new SiftingIoAdapter(key));
      marketEngine.connect("XAUUSD", "SiftingIO WebSocket");
      setApiKey("");
      setMessage("Connection requested. Waiting for the first validated Gold tick.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start the Gold feed.");
    } finally {
      setBusy(false);
    }
  };

  const disconnectGold = () => {
    marketEngine.unregisterAdapter("SiftingIO WebSocket");
    setMessage("Gold feed disconnected. The last accepted price remains visible as OFFLINE.");
  };

  return (
    <section className="surface feed-settings-panel">
      <div className="surface-heading">
        <div>
          <span className="card-kicker">DIRECT MARKET FEEDS</span>
          <h2>Gold data connection</h2>
          <p>Connect the Android app directly to the SiftingIO Gold stream. Windows is not required.</p>
        </div>
        <span className={"chart-state state-" + gold.quote.freshness.toLowerCase()}>
          {gold.quote.freshness}
        </span>
      </div>

      <div className="feed-status-row">
        <div>
          <strong>XAUUSD</strong>
          <span>{quote ? formatPrice(quote.price, quote.digits) : "Waiting for first valid quote"}</span>
          <small>{quote ? quote.provider + " · " + new Date(quote.sourceTimeMs).toLocaleTimeString() : gold.detail ?? "No valid quote received yet"}</small>
        </div>
        <span className={"feed-state feed-" + gold.feedStatus.toLowerCase()}>{gold.feedStatus}</span>
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
        <button className="primary-btn" type="button" onClick={connectGold} disabled={busy || !apiKey.trim()}>
          {busy ? "Connecting..." : "Connect Gold"}
        </button>
      </div>
      <button className="text-btn feed-disconnect" type="button" onClick={disconnectGold}>
        Disconnect Gold feed
      </button>

      {message ? <div className="feed-message" role="status">{message}</div> : null}

      <div className="feed-security-note">
        <strong>Credential handling</strong>
        <p>The key is held in this adapter's runtime memory and is not saved to IndexedDB or localStorage. SiftingIO's WebSocket protocol requires the key in the connection URL, so it may be visible in browser developer tools or connection diagnostics. Use a dedicated, revocable market-data key only. Never enter a broker password, Exness private key or account login here.</p>
      </div>
    </section>
  );
}
