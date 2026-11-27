import { useEffect, useMemo, useState } from "react";
import { analyzeTradingSignal } from "../domain/signals/signal-engine";
import type { SignalRejectionCode, TradingSignal } from "../domain/signals/signal-engine";
import type { SupportedTimeframe } from "../domain/market-data/market-data-engine";
import { quoteStore, marketEngine, outcomeMonitor } from "../domain/market-data/runtime";
import { requestOutcomeNotificationPermission } from "../domain/signals/notification-service";
import type { OutcomeMonitorSnapshot } from "../domain/signals/outcome-monitor";
import { useCanonicalQuote, useCandles } from "../hooks/use-market-data";

const INSTRUMENTS = [
  "XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY",
  "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP",
] as const;

type Instrument = (typeof INSTRUMENTS)[number];
const TIMEFRAMES: SupportedTimeframe[] = ["4h", "1h", "15m", "5m"];

const REJECTION_LABELS: Record<SignalRejectionCode, string> = {
  NO_LIVE_QUOTE: "Waiting for a fresh live quote",
  SOURCE_MISMATCH: "Quote and candle sources do not match",
  INVALID_QUOTE: "Quote failed timestamp or price validation",
  INSUFFICIENT_HISTORY: "Not enough completed candles across all timeframes",
  STALE_CANDLES: "One or more timeframe candle sets are stale",
  HIGHER_TIMEFRAME_CONFLICT: "4H and 1H direction do not agree",
  NO_15M_CONFIRMATION: "No matching 15M structure confirmation",
  NO_5M_TRIGGER: "No matching 5M execution trigger",
  INVALID_RISK: "Stop distance or volatility calculation is invalid",
  RISK_TOO_LARGE: "Stop distance is too large or too close to spread",
  INVALID_TARGETS: "Target prices failed validation",
};

function formatPrice(value: number, digits: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "—";
  if (ageMs < 1_000) return ageMs + " ms";
  return (ageMs / 1_000).toFixed(1) + " s";
}

function TrendPill({ label, value }: { label: string; value: string }) {
  const tone = value === "BULLISH" ? "bullish" : value === "BEARISH" ? "bearish" : "neutral";
  return (
    <div className="signal-trend-cell">
      <span>{label}</span>
      <b className={"trend-" + tone}>{value}</b>
    </div>
  );
}

function RejectionList({ codes }: { codes: readonly SignalRejectionCode[] }) {
  if (codes.length === 0) return null;
  return (
    <div className="signal-rejection-list">
      {codes.map((code) => (
        <div className="signal-rejection-item" key={code}>
          <span>•</span>
          <span>{REJECTION_LABELS[code]}</span>
        </div>
      ))}
    </div>
  );
}

function SignalResultCard({ signal }: { signal: TradingSignal }) {
  const digits = signal.instrumentId === "BTCUSD" ? 2 : signal.instrumentId === "XAUUSD" ? 2 : 5;
  return (
    <div className="signal-result-card">
      <div className="signal-result-top">
        <div>
          <span className="signal-result-kicker">VALIDATED OPPORTUNITY</span>
          <strong>{signal.instrumentId}</strong>
        </div>
        <span className={"signal-side signal-side-" + signal.side.toLowerCase()}>{signal.side}</span>
      </div>
      <div className="signal-entry-row">
        <div><small>ENTRY</small><b>{formatPrice(signal.entry, digits)}</b></div>
        <div><small>STOP LOSS</small><b className="signal-price-down">{formatPrice(signal.stopLoss, digits)}</b></div>
        <div><small>CONFIDENCE</small><b>{signal.confidence}%</b></div>
      </div>
      <div className="signal-target-grid">
        <div><small>TP1 · 1R</small><b>{formatPrice(signal.takeProfits.tp1, digits)}</b></div>
        <div><small>TP2 · 2R</small><b>{formatPrice(signal.takeProfits.tp2, digits)}</b></div>
        <div><small>TP3 · 3R</small><b>{formatPrice(signal.takeProfits.tp3, digits)}</b></div>
      </div>
      <div className="signal-meta-row">
        <span>{signal.timeframe.toUpperCase()} execution</span>
        <span>{signal.structure}</span>
        <span>{signal.source}</span>
      </div>
      <div className="signal-reasoning">
        {signal.reasoning.map((reason) => <p key={reason}>{reason}</p>)}
      </div>
    </div>
  );
}

export default function SignalCentre() {
  const [instrumentId, setInstrumentId] = useState<Instrument>("XAUUSD");
  const [clock, setClock] = useState(() => Date.now());
  const [historyState, setHistoryState] = useState<"IDLE" | "LOADING" | "READY" | "CACHED" | "ERROR">("IDLE");
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);
  const [outcomeSnapshot, setOutcomeSnapshot] = useState<OutcomeMonitorSnapshot>(() => outcomeMonitor.getSnapshot());
  const [notificationPermission, setNotificationPermission] = useState<"unknown" | "granted" | "denied" | "unsupported">("unknown");
  const [notificationBusy, setNotificationBusy] = useState(false);

  const providerId = instrumentId === "BTCUSD" ? "Binance Spot WebSocket" : "SiftingIO WebSocket";
  const quoteSubscription = useCanonicalQuote(instrumentId);

  const candles4h = useCandles(instrumentId, "4h", providerId);
  const candles1h = useCandles(instrumentId, "1h", providerId);
  const candles15m = useCandles(instrumentId, "15m", providerId);
  const candles5m = useCandles(instrumentId, "5m", providerId);

  // Re-evaluate quote freshness even when the upstream provider pauses briefly.
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    setHistoryState("LOADING");
    setHistoryMessage(null);

    Promise.allSettled(
      TIMEFRAMES.map((timeframe) => marketEngine.loadHistory(instrumentId, providerId, timeframe, 240)),
    ).then((results) => {
      if (!active) return;
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : "Historical candle request failed");

      if (failures.length === TIMEFRAMES.length) {
        setHistoryState("ERROR");
        setHistoryMessage(failures[0]);
      } else if (failures.length > 0) {
        setHistoryState("CACHED");
        setHistoryMessage("Some timeframes could not refresh. Previously saved candles remain available.");
      } else {
        setHistoryState("READY");
      }
    });

    return () => { active = false; };
  }, [instrumentId, providerId]);

  const quoteState = quoteStore.getSnapshot(instrumentId);
  const result = useMemo(() => analyzeTradingSignal({
    instrumentId,
    quoteState,
    candles: {
      "4h": candles4h,
      "1h": candles1h,
      "15m": candles15m,
      "5m": candles5m,
    },
    candleProvider: providerId,
    candlePriceBasis: "last",
    nowMs: clock,
  }), [instrumentId, quoteSubscription.version, quoteState.freshness, quoteState.quote?.provider, candles4h, candles1h, candles15m, candles5m, providerId, clock]);

  const selectedQuote = quoteState.quote;
  const signal = result.signal;

  useEffect(() => outcomeMonitor.subscribe(setOutcomeSnapshot), []);

  useEffect(() => {
    if (signal) outcomeMonitor.register(signal);
  }, [signal?.id]);

  const enableOutcomeNotifications = async () => {
    setNotificationBusy(true);
    try {
      const permission = await requestOutcomeNotificationPermission();
      setNotificationPermission(permission);
    } catch (error) {
      console.error("TradeSight could not enable outcome notifications", error);
      setNotificationPermission("denied");
    } finally {
      setNotificationBusy(false);
    }
  };

  const recentEvents = outcomeSnapshot.events
    .filter((event) => event.instrumentId === instrumentId)
    .slice(0, 5);

  return (
    <article className="surface signals-panel signal-centre-panel">
      <div className="surface-heading">
        <div>
          <span className="card-kicker">TRADE OPPORTUNITIES · MULTI-TIMEFRAME</span>
          <h2>Signal centre</h2>
          <p>4H context · 1H structure · 15M confirmation · 5M execution</p>
        </div>
        <span className={"chart-state state-" + (quoteState.freshness === "LIVE" ? "live" : "stale")}>
          {quoteState.freshness}
        </span>
      </div>

      <div className="signal-instrument-row">
        <label htmlFor="signal-instrument">INSTRUMENT</label>
        <select id="signal-instrument" value={instrumentId} onChange={(event) => setInstrumentId(event.target.value as Instrument)}>
          {INSTRUMENTS.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
        </select>
        <span>{historyState === "LOADING" ? "Checking history…" : historyState === "READY" ? "History checked" : historyState === "CACHED" ? "Using available cache" : historyState === "ERROR" ? "History unavailable" : "Ready"}</span>
      </div>

      <div className="signal-market-reference">
        <div>
          <small>CANONICAL MARKET PRICE</small>
          <strong>{selectedQuote ? formatPrice(selectedQuote.price, selectedQuote.digits) : "Waiting for first valid quote"}</strong>
          <span>{selectedQuote ? selectedQuote.provider + " · " + formatAge(quoteState.quoteAgeMs) : "No quote received"}</span>
        </div>
        <div className="signal-quote-time">
          <small>SOURCE TIMESTAMP</small>
          <strong>{selectedQuote ? new Date(selectedQuote.sourceTimeMs).toLocaleTimeString() : "—"}</strong>
          <span>{selectedQuote ? new Date(selectedQuote.sourceTimeMs).toLocaleDateString() : "No source time"}</span>
        </div>
      </div>

      <div className="signal-trend-grid">
        <TrendPill label="4H TREND" value={result.diagnostics.trend4h} />
        <TrendPill label="1H TREND" value={result.diagnostics.trend1h} />
        <TrendPill label="15M STRUCTURE" value={result.diagnostics.structure15m} />
        <TrendPill label="5M TRIGGER" value={result.diagnostics.structure5m} />
      </div>

      {signal ? (
        <SignalResultCard signal={signal} />
      ) : (
        <div className="signal-no-setup">
          <div className="signal-no-setup-head">
            <div className="signal-empty-icon">⌖</div>
            <div>
              <strong>No validated setup yet</strong>
              <p>The scan ran. These are the exact conditions currently preventing a signal.</p>
            </div>
          </div>
          <RejectionList codes={result.diagnostics.rejectionCodes} />
          {result.diagnostics.rejectionCodes.length === 0 ? (
            <p className="signal-no-reasons">No active rejection was returned; the engine is waiting for its next market update.</p>
          ) : null}
        </div>
      )}

      {historyMessage ? <div className="chart-error" role="status">{historyMessage}</div> : null}

      <div className="outcome-alert-controls">
        <div>
          <strong>TP2 and Stop Loss alerts</strong>
          <span>
            {notificationPermission === "granted"
              ? "Device notifications enabled"
              : notificationPermission === "denied"
                ? "Notifications permission denied in device settings"
                : notificationPermission === "unsupported"
                  ? "Native notifications unavailable in this browser"
                  : "Enable system notifications for target and stop events"}
          </span>
        </div>
        <button type="button" onClick={enableOutcomeNotifications} disabled={notificationBusy || notificationPermission === "granted"}>
          {notificationBusy ? "Enabling…" : notificationPermission === "granted" ? "Enabled" : "Enable alerts"}
        </button>
      </div>

      <div className="outcome-history">
        <div className="outcome-history-heading">
          <strong>Recent setup events</strong>
          <span>{recentEvents.length} shown</span>
        </div>
        {recentEvents.length === 0 ? (
          <p className="outcome-history-empty">TP2 and Stop Loss events for this instrument will appear here.</p>
        ) : (
          recentEvents.map((event) => (
            <div className="outcome-history-row" key={event.id}>
              <span className={"outcome-event-dot " + (event.milestone === "SL" ? "is-stop" : "is-target")} />
              <div>
                <strong>{event.instrumentId} · {event.milestone === "SL" ? "Stop Loss hit" : event.milestone + " reached"}</strong>
                <small>{event.side} · {new Date(event.sourceTimeMs).toLocaleString()} · {event.provider}</small>
              </div>
              <b>{formatPrice(event.observedPrice, selectedQuote?.digits ?? 2)}</b>
            </div>
          ))
        )}
      </div>

      <div className="signal-foot">
        <span><i /> SIGNAL ENGINE</span>
        <b>{signal ? "VALIDATED SETUP" : result.diagnostics.rejectionCodes.length + " REJECTION REASONS"}</b>
      </div>
    </article>
  );
}
