import { useEffect, useState } from "react";
import { getQuoteDisplayFreshness } from "../domain/market-data/quote-store";
import {
  COMMODITY_DETAILS,
  COMMODITY_SYMBOLS,
  SIFTING_IO_FOREX_SYMBOLS,
  type SiftingIoInstrument,
} from "../domain/market-data/instrument-catalog";
import { getMarketSessionStatus } from "../domain/market-data/market-session";
import { marketEngine } from "../domain/market-data/runtime";
import type { SupportedTimeframe } from "../domain/market-data/market-data-engine";
import { useCanonicalQuote } from "../hooks/use-market-data";
import { isSnapshotQuote } from "../domain/market-data/types";
import PriceChart from "./PriceChart";

interface MarketChartPanelProps {
  timeframe: SupportedTimeframe;
  onTimeframeChange: (timeframe: SupportedTimeframe) => void;
}

type ChartInstrument = "BTCUSD" | SiftingIoInstrument;

const FOREX_LABELS: Record<(typeof SIFTING_IO_FOREX_SYMBOLS)[number], string> = {
  EURUSD: "Euro / US Dollar",
  GBPUSD: "Pound / US Dollar",
  USDJPY: "US Dollar / Japanese Yen",
  AUDUSD: "Australian Dollar / US Dollar",
  USDCAD: "US Dollar / Canadian Dollar",
  USDCHF: "US Dollar / Swiss Franc",
  NZDUSD: "New Zealand Dollar / US Dollar",
  EURGBP: "Euro / Pound",
};

const INSTRUMENT_LABELS: Record<ChartInstrument, string> = {
  BTCUSD: "Bitcoin / US Dollar",
  ...Object.fromEntries(COMMODITY_SYMBOLS.map((symbol) => [
    symbol,
    COMMODITY_DETAILS[symbol].label + " / US Dollar",
  ])),
  ...FOREX_LABELS,
};

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
  const [clock, setClock] = useState(() => Date.now());
  const providerId = instrumentId === "BTCUSD" ? "Binance Spot" : "SiftingIO Market Data";
  const quote = useCanonicalQuote(instrumentId);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

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
  const quoteStatus = getQuoteDisplayFreshness(quote);
  const session = getMarketSessionStatus(instrumentId, clock);
  const marketClosed = !session.isOpen;
  const status = marketClosed ? "MARKET CLOSED" : quoteStatus;

  return (
    <article className="surface chart-panel">
      <div className="surface-heading">
        <div>
          <span className="card-kicker">PRICE ACTION · CANONICAL FEED</span>
          <h2>{instrumentId} · {INSTRUMENT_LABELS[instrumentId]}</h2>
          <p>{marketClosed
            ? session.detail + " The last accepted price remains visible; new signals and outcome checks are paused."
            : isSnapshotQuote(price)
              ? "The price is a provider reference snapshot; chart candles remain sourced from historical market data."
              : "Watchlist, chart marker and live candle use the same accepted quote snapshot."}</p>
        </div>
        <span className={"chart-state state-" + (marketClosed ? "market-closed" : status.toLowerCase())}>{status}</span>
      </div>

      <div className="chart-price-strip">
        <div>
          <span className="chart-price-label">{marketClosed ? "LAST ACCEPTED PRICE" : "CURRENT PRICE"} · {price?.priceBasis.toUpperCase() ?? "WAITING"}</span>
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
            <optgroup label="Commodities · SiftingIO references">
              {COMMODITY_SYMBOLS.map((symbol) => (
                <option key={symbol} value={symbol}>
                  {symbol} · {COMMODITY_DETAILS[symbol].label} · Exness {COMMODITY_DETAILS[symbol].exnessSymbol}
                </option>
              ))}
            </optgroup>
            <optgroup label="Forex · SiftingIO">
              {SIFTING_IO_FOREX_SYMBOLS.map((symbol) => (
                <option key={symbol} value={symbol}>{symbol} · SiftingIO</option>
              ))}
            </optgroup>
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

      <PriceChart instrumentId={instrumentId} timeframe={timeframe} providerId={providerId} />

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
