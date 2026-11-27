import { useInstrumentMarketState } from "../hooks/use-market-data";

interface MarketWatchCardProps {
  symbol: string;
  name: string;
  accent: string;
  category: string;
}

function formatPrice(price: number, digits: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: true,
  }).format(price);
}

function freshnessLabel(state: string): string {
  return state === "LIVE" ? "LIVE" :
    state === "STALE" ? "STALE" :
    state === "OFFLINE" ? "OFFLINE" : "WAITING";
}

export default function MarketWatchCard({
  symbol,
  name,
  accent,
  category,
}: MarketWatchCardProps) {
  const state = useInstrumentMarketState(symbol);
  const quote = state.quote.quote;
  const freshness = state.quote.freshness;
  const label = freshnessLabel(freshness);

  return (
    <article className={"market-card accent-" + accent}>
      <div className="market-card-head">
        <div className="instrument-ident">
          <span className="instrument-token">{symbol.slice(0, 1)}</span>
          <div><strong>{symbol}</strong><small>{name}</small></div>
        </div>
        <span className="instrument-category">{category}</span>
      </div>

      <div className="market-card-price">
        {quote ? formatPrice(quote.price, quote.digits) : "Waiting for first valid quote"}
      </div>

      <div className="market-card-foot">
        <span className={"state-pill " + freshness.toLowerCase()}><i /> {label}</span>
        <span className="quote-note">
          {quote
            ? (
              (state.detail?.includes("REST snapshot")
                ? "REST SNAPSHOT"
                : state.detail?.includes("WebSocket")
                  ? "WEBSOCKET"
                  : quote.provider) +
              " · " + Math.max(0, Math.floor((state.quote.quoteAgeMs ?? 0) / 1000)) + "s old"
            )
            : state.detail ?? (state.feedStatus === "ERROR" ? "Provider error" : "No price fabricated")}
        </span>
      </div>
    </article>
  );
}
