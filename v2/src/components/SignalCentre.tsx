import { useEffect, useMemo, useState } from "react";
import { analyzeTradingSignal } from "../domain/signals/signal-engine";
import type { SignalRejectionCode, TradingSignal } from "../domain/signals/signal-engine";
import type { SupportedTimeframe } from "../domain/market-data/market-data-engine";
import { getQuoteDisplayFreshness } from "../domain/market-data/quote-store";
import { isSnapshotQuote } from "../domain/market-data/types";
import { isMarketSessionOpen } from "../domain/market-data/market-session";
import { COMMODITY_DETAILS, COMMODITY_SYMBOLS } from "../domain/market-data/instrument-catalog";
import { SIFTING_IO_INSTRUMENTS } from "../domain/market-data/instrument-catalog";
import { quoteStore, marketEngine, outcomeMonitor, signalScanner } from "../domain/market-data/runtime";
import {
  getOutcomeNotificationPermission,
  requestOutcomeNotificationPermission,
} from "../domain/signals/notification-service";
import type { OutcomeMonitorSnapshot } from "../domain/signals/outcome-monitor";
import type { SignalScannerSnapshot } from "../domain/signals/signal-scanner";
import { useCanonicalQuote, useCandles, useInstrumentMarketState } from "../hooks/use-market-data";
import {
  getNativeMarketMonitorStatus,
  isNativeMarketMonitorAvailable,
  startNativeMarketMonitor,
  stopNativeMarketMonitor,
  type MarketMonitorStatus,
} from "../native/market-monitor";

const INSTRUMENTS = [
  "BTCUSD",
  ...SIFTING_IO_INSTRUMENTS,
] as const;

type Instrument = (typeof INSTRUMENTS)[number];

function instrumentLabel(symbol: Instrument): string {
  if (symbol === "BTCUSD") return "Bitcoin / US Dollar";
  if ((COMMODITY_SYMBOLS as readonly string[]).includes(symbol)) {
    return COMMODITY_DETAILS[symbol as keyof typeof COMMODITY_DETAILS].label;
  }
  return symbol;
}
const TIMEFRAMES: SupportedTimeframe[] = ["4h", "1h", "15m", "5m"];
const TIMEFRAME_SECONDS: Record<SupportedTimeframe, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
};

const REJECTION_LABELS: Record<SignalRejectionCode, string> = {
  MARKET_CLOSED: "Market session is closed; signal generation is paused",
  NO_LIVE_QUOTE: "Waiting for a fresh live quote",
  SOURCE_MISMATCH: "Quote and candle sources do not match",
  INVALID_QUOTE: "Quote failed timestamp or price validation",
  INSUFFICIENT_HISTORY: "Not enough completed candles across all timeframes",
  STALE_CANDLES: "One or more timeframe candle sets are stale",
  HIGHER_TIMEFRAME_CONFLICT: "4H and 1H direction do not agree",
  NO_TIMEFRAME_TRIGGER: "No valid structure trigger on this timeframe",
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
  const digits = signal.instrumentId === "BTCUSD" || signal.instrumentId === "XAUUSD" ||
    signal.instrumentId === "XPTUSD" || signal.instrumentId === "XPDUSD" ||
    signal.instrumentId === "XALUSD" || signal.instrumentId === "XCUUSD" ||
    signal.instrumentId === "XNIUSD" || signal.instrumentId === "XPBUSD" ||
    signal.instrumentId === "XZNUSD" ||
    signal.instrumentId === "WTIUSD" || signal.instrumentId === "UKOUSD"
    ? 2
    : signal.instrumentId === "XAGUSD" || signal.instrumentId === "NATGAS"
      ? 3
      : 5;
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
        <div><small>RULE SCORE</small><b>{signal.confidence}/100</b><small>Not a win probability</small></div>
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
  const [scannerSnapshot, setScannerSnapshot] = useState<SignalScannerSnapshot>(() => signalScanner.getSnapshot());
  const [notificationPermission, setNotificationPermission] = useState<"unknown" | "granted" | "denied" | "unsupported">("unknown");
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [nativeMonitor, setNativeMonitor] = useState<MarketMonitorStatus>({
    running: false,
    startedAtMs: null,
    stopReason: null,
  });
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [monitorMessage, setMonitorMessage] = useState<string | null>(null);

  const providerId = instrumentId === "BTCUSD" ? "Binance Spot" : "SiftingIO Market Data";
  const quoteSubscription = useCanonicalQuote(instrumentId);
  const marketState = useInstrumentMarketState(instrumentId);

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
        .map((result, index) => ({
          timeframe: TIMEFRAMES[index],
          result,
        }))
        .filter((item): item is { timeframe: SupportedTimeframe; result: PromiseRejectedResult } =>
          item.result.status === "rejected",
        );
      const historyIssues = results
        .map((result, index) => {
          if (result.status !== "fulfilled") return null;
          const timeframe = TIMEFRAMES[index];
          const seconds = TIMEFRAME_SECONDS[timeframe];
          const completed = result.value.filter((candle) =>
            candle.closed !== false &&
            candle.time * 1_000 + seconds * 1_000 <= Date.now(),
          );
          if (completed.length < 40) {
            return timeframe.toUpperCase() + " (" + completed.length + "/40 completed)";
          }
          const latest = completed[completed.length - 1];
          const latestAgeMs = Date.now() - (latest.time + seconds) * 1_000;
          return latestAgeMs > seconds * 2_000
            ? timeframe.toUpperCase() + " candles stale (" + formatAge(latestAgeMs) + ")"
            : null;
        })
        .filter((item): item is string => item !== null);

      if (failures.length === TIMEFRAMES.length) {
        setHistoryState("ERROR");
        setHistoryMessage(failures[0].result.reason instanceof Error
          ? failures[0].result.reason.message
          : "Historical candle requests failed.");
      } else if (failures.length > 0 || historyIssues.length > 0) {
        setHistoryState("CACHED");
        const failedLabels = failures.map((item) => item.timeframe.toUpperCase());
        const issues = [
          ...failedLabels.map((timeframe) => timeframe + " history request failed"),
          ...historyIssues,
        ];
        setHistoryMessage(
          "Signal history is incomplete: " + issues.join("; ") +
          ". The engine requires at least 40 completed candles on each required timeframe.",
        );
      } else {
        setHistoryState("READY");
        setHistoryMessage(null);
      }
    });

    return () => { active = false; };
  }, [instrumentId, providerId]);

  const quoteState = quoteStore.getSnapshot(instrumentId);
  const quoteStatus = getQuoteDisplayFreshness(quoteState);
  const marketOpen = isMarketSessionOpen(instrumentId, clock);
  const analysisQuoteState = !marketOpen || isSnapshotQuote(quoteState.quote)
    ? { ...quoteState, freshness: "STALE" as const }
    : quoteState;
  const timeframeResults = useMemo(() => TIMEFRAMES.map((timeframe) => ({
    timeframe,
    result: analyzeTradingSignal({
      instrumentId,
      quoteState: analysisQuoteState,
      candles: {
        "4h": candles4h,
        "1h": candles1h,
        "15m": candles15m,
        "5m": candles5m,
      },
      candleProvider: providerId,
      candlePriceBasis: quoteState.quote?.priceBasis ?? "last",
      nowMs: clock,
      targetTimeframe: timeframe,
    }),
  })), [instrumentId, quoteSubscription.version, quoteState.freshness, quoteState.quote?.provider, quoteState.quote?.transport, candles4h, candles1h, candles15m, candles5m, providerId, clock]);

  const result = timeframeResults.find((item) => item.timeframe === "5m")?.result ?? timeframeResults[0].result;
  const fullChainDiagnostics = result.diagnostics;
  const selectedQuote = quoteState.quote;

  useEffect(() => outcomeMonitor.subscribe(setOutcomeSnapshot), []);
  useEffect(() => signalScanner.subscribe(setScannerSnapshot), []);

  useEffect(() => {
    let active = true;
    void getOutcomeNotificationPermission().then((permission) => {
      if (active) setNotificationPermission(permission);
    });
    if (isNativeMarketMonitorAvailable()) {
      void getNativeMarketMonitorStatus().then((status) => {
        if (active) setNativeMonitor(status);
      });
    }
    return () => { active = false; };
  }, []);

  useEffect(() => {
    for (const item of timeframeResults) {
      if (item.result.signal) outcomeMonitor.register(item.result.signal);
    }
  }, [timeframeResults]);

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

  const toggleBackgroundMonitoring = async () => {
    setMonitorBusy(true);
    setMonitorMessage(null);
    try {
      if (nativeMonitor.running) {
        const status = await stopNativeMarketMonitor();
        setNativeMonitor(status);
        setMonitorMessage("Background monitoring session stopped.");
        return;
      }

      let permission = notificationPermission;
      if (permission !== "granted") {
        permission = await requestOutcomeNotificationPermission();
        setNotificationPermission(permission);
      }
      if (permission !== "granted") {
        setMonitorMessage("Allow notifications first so Android can display the required monitoring notification.");
        return;
      }

      const requested = await startNativeMarketMonitor();
      setNativeMonitor(requested);
      setMonitorMessage("Android accepted the monitoring-session request. Confirm the persistent TradeSight notification appears in the notification shade.");
      window.setTimeout(() => {
        void getNativeMarketMonitorStatus().then(setNativeMonitor);
      }, 750);
    } catch (error) {
      setMonitorMessage(error instanceof Error ? error.message : "Android could not start the monitoring session.");
    } finally {
      setMonitorBusy(false);
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
          <p>Independent 4H · 1H · 15M · 5M opportunity scans</p>
        </div>
        <span className={"chart-state state-" + (!marketOpen ? "stale" : quoteStatus === "LIVE" ? "live" : quoteStatus === "SNAPSHOT" ? "snapshot" : "stale")}>
          {marketOpen ? quoteStatus : "MARKET CLOSED"}
        </span>
      </div>

      <div className="signal-instrument-row">
        <label htmlFor="signal-instrument">INSTRUMENT</label>
        <select id="signal-instrument" value={instrumentId} onChange={(event) => setInstrumentId(event.target.value as Instrument)}>
          {INSTRUMENTS.map((symbol) => (
            <option key={symbol} value={symbol}>
              {symbol} · {instrumentLabel(symbol)}
              {symbol in COMMODITY_DETAILS ? " · Exness " + COMMODITY_DETAILS[symbol as keyof typeof COMMODITY_DETAILS].exnessSymbol : ""}
            </option>
          ))}
        </select>
        <span>{!marketOpen ? "MARKET CLOSED · SCANNING PAUSED" : historyState === "LOADING" ? "Checking history…" : historyState === "READY" ? "History checked" : historyState === "CACHED" ? "Using available cache" : historyState === "ERROR" ? "History unavailable" : "Ready"}</span>
      </div>

      <div className="signal-market-reference">
        <div>
          <small>CANONICAL MARKET PRICE</small>
          <strong>{selectedQuote ? formatPrice(selectedQuote.price, selectedQuote.digits) : "Waiting for first valid quote"}</strong>
          <span>{selectedQuote ? selectedQuote.providerSymbol + " · " + selectedQuote.provider + " · " + formatAge(quoteState.quoteAgeMs) : "No quote received"}</span>
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

      <div className="signal-timeframe-grid">
        {timeframeResults.map(({ timeframe, result: candidate }) => (
          <section className="signal-timeframe-card" key={timeframe}>
            <div className="signal-timeframe-heading">
              <strong>{timeframe.toUpperCase()} candidate</strong>
              <span className={"signal-scan-status " + (marketOpen && candidate.signal ? "has-signal" : "no-signal")}>
                {!marketOpen ? "MARKET CLOSED" : candidate.signal ? "SETUP VALIDATED" : "NO SETUP"}
              </span>
            </div>
            {!marketOpen ? (
              <div className="signal-timeframe-rejection">
                <p className="signal-no-reasons">Scanning is paused until this market's next scheduled session.</p>
              </div>
            ) : candidate.signal ? (
              <SignalResultCard signal={candidate.signal} />
            ) : (
              <div className="signal-timeframe-rejection">
                <RejectionList codes={candidate.diagnostics.rejectionCodes} />
                {candidate.diagnostics.rejectionCodes.length === 0 ? (
                  <p className="signal-no-reasons">Waiting for a qualifying structure trigger.</p>
                ) : null}
              </div>
            )}
          </section>
        ))}
      </div>

      <section className="signal-diagnostics-panel" aria-label="Signal engine diagnostics">
        <div className="signal-diagnostics-heading">
          <div>
            <strong>Signal engine diagnostics</strong>
            <span>Live quote, feed connection and completed history used by the strict multi-timeframe rules</span>
          </div>
          <span className={"signal-diagnostics-state " + (marketOpen && quoteStatus === "LIVE" ? "is-ready" : "is-blocked")}>
            {!marketOpen ? "MARKET CLOSED" : quoteStatus === "LIVE" ? "LIVE INPUT" : "SIGNAL INPUT BLOCKED"}
          </span>
        </div>

        <div className="signal-diagnostics-quote">
          <div>
            <small>PROVIDER CONNECTION</small>
            <b>{marketState.feedStatus}</b>
          </div>
          <div>
            <small>QUOTE FRESHNESS</small>
            <b>{quoteStatus}</b>
          </div>
          <div>
            <small>TRANSPORT</small>
            <b>{selectedQuote?.transport ?? "NO QUOTE"}</b>
          </div>
          <div>
            <small>QUOTE AGE</small>
            <b>{formatAge(quoteState.quoteAgeMs)}</b>
          </div>
        </div>
        {!marketOpen
          ? <p className="signal-diagnostics-detail">This instrument is outside its scheduled trading session. New signal scans, strategy candles and TP/SL quote evaluation are paused; BTCUSD remains available 24/7.</p>
          : marketState.detail ? <p className="signal-diagnostics-detail">{marketState.detail}</p> : null}

        <div className="signal-candle-health">
          <div className="signal-candle-health-heading">
            <strong>Required candle history · 5M execution chain</strong>
            <span>Minimum 40 completed bars per timeframe</span>
          </div>
          {TIMEFRAMES.map((timeframe) => {
            const candle = fullChainDiagnostics.candles[timeframe];
            const status = !candle.sufficientHistory
              ? "INSUFFICIENT"
              : !candle.fresh
                ? "STALE"
                : "READY";
            return (
              <div className="signal-candle-health-row" key={timeframe}>
                <strong>{timeframe.toUpperCase()}</strong>
                <span>{candle.completedCount}/{candle.minimumRequired} completed</span>
                <small>{candle.latestAgeMs === null ? "No completed candle" : "Last close " + formatAge(candle.latestAgeMs) + " ago"}</small>
                <b className={"signal-candle-health-state state-" + status.toLowerCase()}>{status}</b>
              </div>
            );
          })}
        </div>
        <div className="signal-diagnostics-foot">
          <strong>Note:</strong> Candles only qualify when completed. A live quote alone cannot generate a signal without sufficient fresh history and a confirmed structural trigger.
        </div>
      </section>

      {historyMessage ? <div className="chart-error" role="status">{historyMessage}</div> : null}

      <div className="outcome-alert-controls">
        <div>
          <strong>TP1, TP2, TP3 and Stop Loss alerts</strong>
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

      <div className="background-monitor-controls">
        <div className="background-monitor-heading">
          <div>
            <strong>Android background monitoring</strong>
            <span>
              {nativeMonitor.running
                ? "Foreground session active since " + (nativeMonitor.startedAtMs ? new Date(nativeMonitor.startedAtMs).toLocaleTimeString() : "recently")
                : "Keeps a visible Android monitoring session active while the screen is off."}
            </span>
          </div>
          <span className={"monitor-state " + (nativeMonitor.running ? "monitor-active" : "monitor-stopped")}>
            {nativeMonitor.running ? "ACTIVE" : "STOPPED"}
          </span>
        </div>
        <button
          type="button"
          className={nativeMonitor.running ? "monitor-stop-button" : "monitor-start-button"}
          onClick={toggleBackgroundMonitoring}
          disabled={monitorBusy || !isNativeMarketMonitorAvailable()}
        >
          {monitorBusy ? "Please wait…" : nativeMonitor.running ? "Stop background monitoring" : "Start background monitoring"}
        </button>
        {!isNativeMarketMonitorAvailable() ? (
          <p className="monitor-note">This control is available in the Android APK, not the browser/PWA preview.</p>
        ) : (
          <p className="monitor-note">Android limits data-sync foreground sessions to six hours per 24 hours on Android 15+. This service keeps the app process important and holds a partial wake lock; the JavaScript feed and outcome engine still need real-device screen-off testing. Force-stop, battery policy or network loss can interrupt monitoring. It is not a 24/7 guarantee.</p>
        )}
        {nativeMonitor.stopReason ? <p className="monitor-note">{nativeMonitor.stopReason}</p> : null}
        {monitorMessage ? <p className="monitor-message" role="status">{monitorMessage}</p> : null}
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

      <div className="signal-scan-audit">
        <div className="signal-scan-audit-head">
          <div>
            <strong>Background instrument scanner</strong>
            <span>Scans only during each instrument's trading session; BTCUSD runs 24/7</span>
          </div>
          <div className="signal-scan-totals">
            <b>{scannerSnapshot.totalScans} <small>SCANS</small></b>
            <b>{scannerSnapshot.totalSignals} <small>NEW SETUPS</small></b>
          </div>
        </div>
        {scannerSnapshot.records.length === 0 ? (
          <p className="signal-no-reasons">Waiting for validated market ticks. Connect the selected Gold/Forex feeds to start scanning those instruments; BTCUSD starts automatically when internet is available.</p>
        ) : (
          <div className="signal-scan-records">
            {scannerSnapshot.records.slice(0, 10).map((record) => (
              <div className="signal-scan-record" key={record.instrumentId}>
                <div className="signal-scan-name">
                  <strong>{record.instrumentId}</strong>
                  <small>{record.provider} · {new Date(record.scannedAt).toLocaleTimeString()}</small>
                </div>
                <span className={"signal-scan-status " + (
                  !isMarketSessionOpen(record.instrumentId, clock) || record.status === "MARKET_CLOSED"
                    ? "market-closed"
                    : record.status === "WAITING_FOR_TICK"
                      ? "waiting-for-tick"
                      : record.status === "SIGNAL"
                        ? "has-signal"
                        : "no-signal"
                )}>
                  {!isMarketSessionOpen(record.instrumentId, clock) || record.status === "MARKET_CLOSED"
                    ? "MARKET CLOSED"
                    : record.status === "WAITING_FOR_TICK"
                      ? "WAITING FOR TICK"
                      : record.status === "SIGNAL"
                        ? "SETUP"
                        : "NO SETUP"}
                </span>
                <div className="signal-scan-detail">
                  {record.sessionDetail ??
                    (record.status === "SIGNAL"
                      ? record.signalId
                      : record.rejectionCodes.length
                        ? record.rejectionCodes.slice(0, 2).map((code) => REJECTION_LABELS[code]).join(" · ")
                        : "No rejection recorded")}
                </div>
                <span className="signal-scan-count">
                  {!isMarketSessionOpen(record.instrumentId, clock) || record.status === "MARKET_CLOSED"
                    ? record.scanCount + " valid scans · PAUSED"
                    : record.status === "WAITING_FOR_TICK"
                      ? record.scanCount + " valid scans · WAITING"
                      : record.scanCount + " scans · " + record.generatedCount + " new"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="signal-foot">
        <span><i /> SIGNAL ENGINE</span>
        <b>{timeframeResults.filter((item) => item.result.signal).length} VALIDATED TIMEFRAME SETUPS</b>
      </div>
    </article>
  );
}
