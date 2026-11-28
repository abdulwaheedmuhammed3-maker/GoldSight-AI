import { useEffect, useState } from "react";
import { getQuoteDisplayFreshness } from "../domain/market-data/quote-store";
import { getMarketSessionStatus } from "../domain/market-data/market-session";
import { useInstrumentMarketState } from "../hooks/use-market-data";

interface MarketWatchCardProps {
  symbol: string;
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

export default function MarketWatchCard({
  symbol,
  accent,
  category,
}: MarketWatchCardProps) {
  const [clock, setClock] = useState(() => Date.now());
  const state = useInstrumentMarketState(symbol);
  const quote = state.quote.quote;
  const displayFreshness = getQuoteDisplayFreshness(state.quote);
  const session = getMarketSessionStatus(symbol, clock);
  const isClosed = !session.isOpen;
  const freshnessClass = displayFreshness.toLowerCase();

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className={"market-card accent-" + accent}>
      <div className="market-card-head">
        <div className="instrument-ident">
          <span className="instrument-token">{symbol.slice(0, 1)}</span>
          <div><strong>{symbol}</strong></div>
        </div>
        <span className="instrument-category">{category}</span>
      </div>

      <div className="market-card-price">
        {quote ? formatPrice(quote.price, quote.digits) : "Waiting for first valid quote"}
      </div>

      <div className="market-card-foot">
        <div className="market-state-group">
          <span className={"state-pill " + freshnessClass}><i /> {displayFreshness}</span>
          {isClosed ? (
            <span className="state-pill market-closed" title={session.detail}><i /> SESSION CLOSED</span>
          ) : null}
        </div>
        <span className="quote-note">
          {quote
            ? (
              (quote.transport === "REST_SNAPSHOT"
                ? "REST SNAPSHOT"
                : quote.transport === "WEBSOCKET_SNAPSHOT"
                  ? "WEBSOCKET SNAPSHOT"
                  : quote.transport === "WEBSOCKET"
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
