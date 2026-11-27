import { useEffect, useState } from "react";
import { marketEngine } from "../domain/market-data/runtime";
import type { SupportedTimeframe } from "../domain/market-data/market-data-engine";
import { useCanonicalQuote } from "../hooks/use-market-data";
import PriceChart from "./PriceChart";

interface MarketChartPanelProps {
  timeframe: SupportedTimeframe;
  onTimeframeChange: (timeframe: SupportedTimeframe) => void;
}

type ChartInstrument = "BTCUSD" | "XAUUSD";

function formatPrice(price: number, digits: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(price);
}

export default function MarketChartPanel({
  timeframe,
  onTimeframeChange,
}: MarketChartPanelProps) {
  const [instrumentId, setInstrumentId] = useState<ChartInstrument>("BTCUSD");
  const providerId = instrumentId === "BTCUSD" ? "Binance Spot WebSocket" : "SiftingIO WebSocket";
  const quote = useCanonicalQuote(instrumentId);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    marketEngine.loadHistory(instrumentId, providerId, timeframe, 240)
      .then(() => {
        if (active) setHistoryError(null);
      })
      .catch((error: unknown) => {
        if (active) {
          setHistoryError(error instanceof Error ? error.message : "Candle history is temporarily unavailable.");
        }
      });
    return () => { active = false; };
  }, [instrumentId, providerId, timeframe]);

  const price = quote.quote;
  const status = quote.freshness;

  return (
    <article className="surface chart-panel">
      <div className="surface-heading">
        <div>
          <span className="card-kicker">PRICE ACTION · CANONICAL FEED</span>
          <h2>{instrumentId} · {instrumentId === "BTCUSD" ? "Bitcoin / US Dollar" : "Gold / US Dollar"}</h2>
          <p>Watchlist, chart marker and live candle use the same accepted quote snapshot.</p>
        </div>
        <span className={"chart-state state-" + status.toLowerCase()}>{status}</span>
      </div>

      <div className="chart-price-strip">
        <div>
          <span className="chart-price-label">CURRENT PRICE · {price?.priceBasis.toUpperCase() ?? "WAITING"}</span>
          <strong>{price ? formatPrice(price.price, price.digits) : "Waiting for first valid quote"}</strong>
        </div>
        <div className="chart-price-meta">
          <span>{price ? "Source time " + new Date(price.sourceTimeMs).toLocaleTimeString() : "No market tick received yet"}</span>
          <span>{price ? price.provider : "Feed not connected"}</span>
        </div>
      </div>

      <div className="chart-tools">
        <label className="symbol-select">
          <span className={"symbol-dot " + (instrumentId === "BTCUSD" ? "blue" : "gold")} />
          <select value={instrumentId} onChange={(event) => setInstrumentId(event.target.value as ChartInstrument)}>
            <option value="BTCUSD">BTCUSD · Binance spot</option>
            <option value="XAUUSD">XAUUSD · SiftingIO</option>
          </select>
        </label>
        <div className="timeframe-list">
          {(["5m", "15m", "1h", "4h"] as const).map((item) => (
            <button
              className={timeframe === item ? "selected" : ""}
              onClick={() => onTimeframeChange(item)}
              key={item}
              type="button"
            >
              {item.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <PriceChart instrumentId={instrumentId} timeframe={timeframe} />

      {historyError ? (
        <div className="chart-error" role="status">
          Historical candles could not be refreshed: {historyError}. The last accepted quote remains visible.
        </div>
      ) : null}

      <div className="chart-footer">
        <span>TIMEFRAME <b>{timeframe.toUpperCase()}</b></span>
        <span>PRICE BASIS <b>{price?.priceBasis.toUpperCase() ?? "PROVIDER-DEFINED"}</b></span>
        <span>SOURCE <b>{price?.provider ?? "NOT CONNECTED"}</b></span>
      </div>
    </article>
  );
}
