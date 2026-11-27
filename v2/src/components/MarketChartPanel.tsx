import { useEffect, useState } from "react";
import { marketEngine } from "../domain/market-data/runtime";
import type { SupportedTimeframe } from "../domain/market-data/market-data-engine";
import { useCanonicalQuote } from "../hooks/use-market-data";
import PriceChart from "./PriceChart";

interface MarketChartPanelProps {
  timeframe: SupportedTimeframe;
  onTimeframeChange: (timeframe: SupportedTimeframe) => void;
}

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
  const quote = useCanonicalQuote("BTCUSD");
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    marketEngine.loadHistory("BTCUSD", "binance-spot", timeframe, 240)
      .then(() => {
        if (active) setHistoryError(null);
      })
      .catch((error: unknown) => {
        if (active) {
          setHistoryError(error instanceof Error ? error.message : "Candle history is temporarily unavailable.");
        }
      });
    return () => { active = false; };
  }, [timeframe]);

  const price = quote.quote;
  const status = quote.freshness;

  return (
    <article className="surface chart-panel">
      <div className="surface-heading">
        <div>
          <span className="card-kicker">PRICE ACTION · CANONICAL FEED</span>
          <h2>BTCUSD · Bitcoin / US Dollar</h2>
          <p>Binance spot reference. Watchlist, chart marker and live candle share one quote snapshot.</p>
        </div>
        <span className={"chart-state state-" + status.toLowerCase()}>{status}</span>
      </div>

      <div className="chart-price-strip">
        <div>
          <span className="chart-price-label">CURRENT PRICE · LAST TRADE</span>
          <strong>{price ? formatPrice(price.price, price.digits) : "Waiting for first valid quote"}</strong>
        </div>
        <div className="chart-price-meta">
          <span>{price ? "Source time " + new Date(price.sourceTimeMs).toLocaleTimeString() : "No market tick received yet"}</span>
          <span>{price ? price.provider : "Feed connecting"}</span>
        </div>
      </div>

      <div className="chart-tools">
        <div className="symbol-select"><span className="symbol-dot blue" /> BTCUSD <span className="chevron">⌄</span></div>
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

      <PriceChart instrumentId="BTCUSD" timeframe={timeframe} />

      {historyError ? (
        <div className="chart-error" role="status">
          Historical candles could not be refreshed: {historyError}. The last accepted quote remains visible.
        </div>
      ) : null}

      <div className="chart-footer">
        <span>TIMEFRAME <b>{timeframe.toUpperCase()}</b></span>
        <span>PRICE BASIS <b>LAST TRADE</b></span>
        <span>SOURCE <b>BINANCE SPOT</b></span>
      </div>
    </article>
  );
}
