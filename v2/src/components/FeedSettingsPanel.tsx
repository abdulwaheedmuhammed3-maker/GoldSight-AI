import { useEffect, useState } from "react";
import { connectSiftingIoFeeds, disconnectSiftingIoFeeds } from "../domain/market-data/runtime";
import { COMMODITY_SYMBOLS } from "../domain/market-data/instrument-catalog";
import {
  MAX_FREE_LIVE_SUBSCRIPTIONS,
  readSelectedSiftingIoSymbols,
  SUPPORTED_FOREX_SYMBOLS,
} from "../domain/market-data/feed-preferences";
import {
  canPersistMarketCredentials,
  clearSiftingIoCredential,
  readSiftingIoCredential,
  saveSiftingIoCredential,
} from "../domain/market-data/secure-credentials";
import { isSnapshotQuote } from "../domain/market-data/types";
import { useInstrumentMarketState } from "../hooks/use-market-data";
import {
  announceFeedSelectionChanged,
  FEED_SELECTION_STORAGE_KEY,
} from "../domain/market-data/feed-preferences";

const FOREX_FEED_SYMBOLS = SUPPORTED_FOREX_SYMBOLS.map((symbol) => ({
  symbol,
  market: "forex" as const,
}));

const COMMODITY_FEED_SYMBOLS = COMMODITY_SYMBOLS.map((symbol) => ({
  symbol,
  market: "commodities" as const,
}));

const FEED_SYMBOLS = [...FOREX_FEED_SYMBOLS, ...COMMODITY_FEED_SYMBOLS] as const;

type FeedSymbol = (typeof FEED_SYMBOLS)[number]["symbol"];
const initialSelectedSymbols = (): FeedSymbol[] =>
  readSelectedSiftingIoSymbols().filter((symbol): symbol is FeedSymbol =>
    FEED_SYMBOLS.some((item) => item.symbol === symbol),
  );

function formatPrice(price: number, digits: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(price);
}

function FeedInstrumentStatus({ symbol }: { symbol: FeedSymbol }) {
  const state = useInstrumentMarketState(symbol);
  const quote = state.quote.quote;
  const snapshotFresh = isSnapshotQuote(quote) &&
    (state.quote.quoteAgeMs ?? Number.POSITIVE_INFINITY) <= 7 * 60_000;
  const displayedStatus = snapshotFresh ? "SNAPSHOT" : state.quote.freshness;

  return (
    <div className="feed-status-row">
      <div>
        <strong>{symbol}</strong>
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
  const [selectedSymbols, setSelectedSymbols] = useState<FeedSymbol[]>(initialSelectedSymbols);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rememberKey, setRememberKey] = useState(true);
  const [hasSavedCredential, setHasSavedCredential] = useState(false);
  const secureStorageAvailable = canPersistMarketCredentials();


  useEffect(() => {
    let active = true;
    void readSiftingIoCredential()
      .then((savedKey) => {
        if (active) setHasSavedCredential(Boolean(savedKey));
      })
      .catch((error: unknown) => {
        if (active) setMessage(
          error instanceof Error
            ? "Saved SiftingIO key could not be read: " + error.message
            : "Saved SiftingIO key could not be read.",
        );
      });
    return () => { active = false; };
  }, []);

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
    if (selectedSymbols.length >= MAX_FREE_LIVE_SUBSCRIPTIONS) {
      setMessage(
        "SiftingIO's free plan provides five shared live WebSocket subscriptions across Forex and commodities. Remove one selected priority before adding another.",
      );
      return;
    }
    setSelectedSymbols((current) => [...current, symbol]);
    setMessage(null);
  };


  const connectSelected = async () => {
    let key = apiKey.trim();
    if (!key && secureStorageAvailable && hasSavedCredential) {
      try {
        key = (await readSiftingIoCredential())?.trim() ?? "";
      } catch (error) {
        setMessage(error instanceof Error
          ? "Saved SiftingIO key could not be read: " + error.message
          : "Saved SiftingIO key could not be read.");
        return;
      }
    }
    if (!key) {
      setMessage("Enter your SiftingIO market-data API key, or save one on this Android device.");
      return;
    }
    if (selectedSymbols.length > MAX_FREE_LIVE_SUBSCRIPTIONS) {
      setMessage("Choose no more than five live priorities in total on the SiftingIO free plan.");
      return;
    }
    if (selectedSymbols.length === 0) {
      setMessage("Select at least one instrument to connect.");
      return;
    }

    setBusy(true);
    let credentialNote = "";
    try {
      if (secureStorageAvailable) {
        try {
          if (rememberKey) {
            await saveSiftingIoCredential(key);
            setHasSavedCredential(true);
            credentialNote = " The key is encrypted with Android Keystore and will reconnect automatically when you reopen TradeSight.";
          } else {
            await clearSiftingIoCredential();
            setHasSavedCredential(false);
            credentialNote = " This key will be used for this app session only.";
          }
        } catch (storageError) {
          credentialNote = " Secure saving failed, so this connection will last only until the app closes.";
          console.warn("TradeSight could not persist the SiftingIO credential.", storageError);
        }
      } else {
        credentialNote = " Browser/PWA mode keeps the key in memory only; secure Android key storage is available in the installed APK.";
      }

      connectSiftingIoFeeds(key, selectedSymbols);
      setApiKey("");
      const streamingFx = selectedSymbols.filter((symbol) =>
        FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "forex",
      ).length;
      const streamingCommodities = selectedSymbols.filter((symbol) =>
        FEED_SYMBOLS.find((item) => item.symbol === symbol)?.market === "commodities",
      ).length;
      setMessage(
        "Feed connections started for " + streamingFx + " Forex and " + streamingCommodities +
        " commodity selections. TradeSight requests live streams in your selection order; symbols beyond SiftingIO's acknowledged subscription limit use reference snapshots and cannot generate live signal setups." +
        credentialNote,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start the market-data feed.");
    } finally {
      setBusy(false);
    }
  };

  const disconnectFeeds = async () => {
    disconnectSiftingIoFeeds();
    try {
      await clearSiftingIoCredential();
      setHasSavedCredential(false);
      setMessage("SiftingIO disconnected and the saved device key was deleted. Reopening TradeSight will not reconnect until you connect again.");
    } catch {
      setMessage("SiftingIO disconnected, but the saved key could not be deleted. Please try Disconnect again.");
    }
  };

  return (
    <section className="surface feed-settings-panel">
      <div className="surface-heading">
        <div>
          <span className="card-kicker">DIRECT MARKET FEEDS</span>
          <h2>Forex and commodities connections</h2>
          <p>Choose the Forex pairs and commodities you want TradeSight to watch. Instruments are displayed by their trading symbols.</p>
        </div>
        <span className="chart-state">{secureStorageAvailable ? "SECURE DEVICE KEY" : "SESSION KEY"}</span>
      </div>

      <div className="feed-instrument-picker">
        <div className="feed-picker-heading">
          <strong>Preferred streaming symbols</strong>
          <span>{selectedSymbols.length}/{MAX_FREE_LIVE_SUBSCRIPTIONS} shared live slots</span>
        </div>
        <div className="feed-symbol-grid">
          {FEED_SYMBOLS.map(({ symbol, market }) => (
            <label className={"feed-symbol-option " + (selectedSymbols.includes(symbol) ? "selected" : "")} key={symbol}>
              <input
                type="checkbox"
                checked={selectedSymbols.includes(symbol)}
                disabled={
                  !selectedSymbols.includes(symbol) &&
                  selectedSymbols.length >= MAX_FREE_LIVE_SUBSCRIPTIONS
                }
                onChange={() => toggleSymbol(symbol)}
              />
              <span>
                <strong>{symbol}</strong>
                {selectedSymbols.includes(symbol) ? <small>Priority {selectedSymbols.indexOf(symbol) + 1}</small> : null}
              </span>
            </label>
          ))}
        </div>
        <p className="feed-plan-note">The SiftingIO free plan provides five shared live WebSocket symbol subscriptions across Forex and commodities. You can select five instruments total; selection order determines priority. The first five are connected as live streams when the provider acknowledges all five. These instruments can drive candles, signal scans and TP/SL monitoring. To watch another instrument, deselect one first. Unselected catalogue instruments are not polled, avoiding REST snapshot overuse. The free tier is for individual internal, non-commercial use; each permitted user must use their own key.</p>
      </div>


      <label className="feed-key-label" htmlFor="sifting-api-key">SiftingIO API key</label>
      {secureStorageAvailable ? (
        <label className="feed-remember-key">
          <input
            type="checkbox"
            checked={rememberKey}
            onChange={(event) => setRememberKey(event.target.checked)}
          />
          <span>
            <strong>Remember this key securely on this Android device</strong>
            <small>Encrypted with Android Keystore. TradeSight will reconnect your saved feeds when you reopen the app.</small>
          </span>
        </label>
      ) : null}
      {hasSavedCredential ? (
        <div className="feed-message" role="status">
          A SiftingIO key is saved securely on this device. Feeds reconnect automatically when TradeSight starts. Enter a new key below only to replace it.
        </div>
      ) : null}
      <div className="feed-key-row">
        <input
          id="sifting-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasSavedCredential ? "Enter a new key to replace the saved key" : "Paste a dedicated market-data key"}
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
        {FEED_SYMBOLS.map(({ symbol }) => (
          <FeedInstrumentStatus key={symbol} symbol={symbol} />
        ))}
      </div>

      <div className="feed-security-note">
        <strong>Free-tier and credential handling</strong>
        <p>On Android, the optional remembered key is encrypted with a device-bound AES key held by Android Keystore; it is not written in plaintext to localStorage or IndexedDB. In browser/PWA mode, the key remains in memory only and must be entered again after a restart. Disconnect deletes the remembered key. SiftingIO requires the key in the WebSocket connection URL, so it may be visible in browser developer tools or connection diagnostics while connected. Use a dedicated, revocable market-data key only. Each user must use their own key for their own permitted use; do not embed a shared key in the public website. Never enter a broker password, Exness private key or account login here.</p>
      </div>
    </section>
  );
}
