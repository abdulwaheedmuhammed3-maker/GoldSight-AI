import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createTradeJournalRecord,
  tradeJournalRepository,
  type JournalSide,
  type JournalTimeframe,
  type TradeJournalRecord,
} from "../domain/trades/trade-journal";
import { useVisibleInstrumentSymbols } from "../hooks/use-visible-instruments";
const timeframes: JournalTimeframe[] = ["5m", "15m", "1h", "4h"];

function toLocalInputValue(date: Date): string {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function displayDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
}

export default function JournalWorkspace() {
  const instruments = useVisibleInstrumentSymbols();
  const visibleInstrumentSet = useMemo(() => new Set<string>(instruments), [instruments]);
  const [records, setRecords] = useState<readonly TradeJournalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("ALL");
  const [instrumentId, setInstrumentId] = useState("XAUUSD");
  const [side, setSide] = useState<JournalSide>("BUY");
  const [timeframe, setTimeframe] = useState<JournalTimeframe>("15m");
  const [entryPrice, setEntryPrice] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [openedAt, setOpenedAt] = useState(() => toLocalInputValue(new Date(Date.now() - 60 * 60_000)));
  const [closedAt, setClosedAt] = useState(() => toLocalInputValue(new Date()));
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (filter !== "ALL" && !visibleInstrumentSet.has(filter)) {
      setFilter("ALL");
    }
    if (!visibleInstrumentSet.has(instrumentId)) {
      setInstrumentId("XAUUSD");
    }
  }, [filter, instrumentId, visibleInstrumentSet]);

  useEffect(() => {
    let active = true;
    void tradeJournalRepository.list()
      .then((items) => {
        if (active) setRecords(items);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "Could not open the local journal.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const visibleRecords = useMemo(
    () => records.filter((record) =>
      visibleInstrumentSet.has(record.instrumentId) &&
      (filter === "ALL" || record.instrumentId === filter),
    ),
    [filter, records, visibleInstrumentSet],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setSaving(true);
    try {
      const record = createTradeJournalRecord({
        instrumentId,
        side,
        timeframe,
        entryPrice: Number(entryPrice),
        exitPrice: Number(exitPrice),
        stopLoss: Number(stopLoss),
        openedAtMs: new Date(openedAt).getTime(),
        closedAtMs: new Date(closedAt).getTime(),
        notes,
      });
      await tradeJournalRepository.save(record);
      setRecords((current) => [record, ...current].sort((a, b) => b.closedAtMs - a.closedAtMs));
      setMessage("Trade saved on this device.");
      setEntryPrice("");
      setExitPrice("");
      setStopLoss("");
      setNotes("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const removeRecord = async (id: string) => {
    setMessage(null);
    try {
      await tradeJournalRepository.delete(id);
      setRecords((current) => current.filter((record) => record.id !== id));
      setMessage("Trade removed from this device.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade could not be deleted.");
    }
  };

  const winCount = records.filter((record) => record.outcome === "WIN").length;
  const netR = records.reduce((sum, record) => sum + record.resultR, 0);

  return (
    <div className="journal-workspace">
      <section className="journal-summary-strip">
        <div><small>RECORDED TRADES</small><strong>{records.length}</strong></div>
        <div><small>WIN RATE</small><strong>{records.length ? (winCount / records.length * 100).toFixed(1) + "%" : "—"}</strong></div>
        <div><small>NET RESULT</small><strong className={netR > 0 ? "is-positive" : netR < 0 ? "is-negative" : ""}>{records.length ? (netR > 0 ? "+" : "") + netR.toFixed(2) + "R" : "—"}</strong></div>
      </section>

      <section className="journal-form-panel surface">
        <div className="journal-panel-heading">
          <div><span className="card-kicker">TRADE ENTRY</span><h2>Record a completed trade</h2><p>Manual journal entry. Results are calculated in R, not cash.</p></div>
          <span className="journal-local-badge"><i /> SAVED ON DEVICE</span>
        </div>
        <form className="journal-form" onSubmit={handleSubmit}>
          <div className="journal-field-grid journal-fields-three">
            <label>Instrument
              <select value={instrumentId} onChange={(event) => setInstrumentId(event.target.value)}>
                {instruments.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
              </select>
            </label>
            <label>Direction
              <select value={side} onChange={(event) => setSide(event.target.value as JournalSide)}>
                <option value="BUY">BUY</option><option value="SELL">SELL</option>
              </select>
            </label>
            <label>Timeframe
              <select value={timeframe} onChange={(event) => setTimeframe(event.target.value as JournalTimeframe)}>
                {timeframes.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
              </select>
            </label>
          </div>
          <div className="journal-field-grid journal-fields-three">
            <label>Entry price
              <input type="number" min="0" step="any" required value={entryPrice} onChange={(event) => setEntryPrice(event.target.value)} placeholder="e.g. 2650.00"/>
            </label>
            <label>Exit price
              <input type="number" min="0" step="any" required value={exitPrice} onChange={(event) => setExitPrice(event.target.value)} placeholder="e.g. 2670.00"/>
            </label>
            <label>Stop-loss
              <input type="number" min="0" step="any" required value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} placeholder="e.g. 2640.00"/>
            </label>
          </div>
          <div className="journal-field-grid journal-fields-two">
            <label>Opened at
              <input type="datetime-local" required value={openedAt} onChange={(event) => setOpenedAt(event.target.value)}/>
            </label>
            <label>Closed at
              <input type="datetime-local" required value={closedAt} onChange={(event) => setClosedAt(event.target.value)}/>
            </label>
          </div>
          <label className="journal-notes-label">Trade notes
            <textarea rows={3} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Setup, session, execution quality, mistakes and lessons learned…"/>
          </label>
          <div className="journal-form-footer">
            <span>R = result distance ÷ initial stop distance</span>
            <button className="journal-save-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save trade"} <b>↗</b></button>
          </div>
          {message ? <p className="journal-message" role="status">{message}</p> : null}
        </form>
      </section>

      <section className="journal-history-panel surface">
        <div className="journal-history-heading">
          <div><span className="card-kicker">YOUR RECORDS</span><h2>Trade history</h2></div>
          <select aria-label="Filter trades by instrument" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="ALL">All instruments</option>
            {instruments.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
          </select>
        </div>
        {loading ? <p className="journal-empty">Loading your local trades…</p> : null}
        {loadError ? <p className="journal-error">{loadError}</p> : null}
        {!loading && !loadError && visibleRecords.length === 0 ? (
          <div className="journal-empty-state"><span>▤</span><strong>No trades recorded yet</strong><p>Save your first completed trade above. Your records stay in this browser or app installation.</p></div>
        ) : null}
        <div className="journal-record-list">
          {visibleRecords.map((record) => (
            <article className="journal-record" key={record.id}>
              <div className="journal-record-main">
                <div className="journal-record-title"><strong>{record.instrumentId}</strong><span className={record.side === "BUY" ? "journal-side-buy" : "journal-side-sell"}>{record.side}</span><small>{record.timeframe.toUpperCase()}</small></div>
                <p>{displayDate(record.closedAtMs)} · Entry {formatPrice(record.entryPrice)} · Exit {formatPrice(record.exitPrice)}</p>
                {record.notes ? <p className="journal-record-notes">{record.notes}</p> : null}
              </div>
              <div className="journal-record-result">
                <strong className={record.resultR > 0 ? "is-positive" : record.resultR < 0 ? "is-negative" : ""}>{record.resultR > 0 ? "+" : ""}{record.resultR.toFixed(2)}R</strong>
                <span className={"journal-outcome outcome-" + record.outcome.toLowerCase()}>{record.outcome}</span>
                <button type="button" onClick={() => void removeRecord(record.id)} aria-label={"Delete " + record.instrumentId + " trade"}>Delete</button>
              </div>
            </article>
          ))}
        </div>
        <p className="journal-storage-note">These entries are stored locally. They do not sync to another device and are not connected to a broker account.</p>
      </section>
    </div>
  );
}
