import { useEffect, useMemo, useState } from "react";
import { tradeJournalRepository, type TradeJournalRecord } from "../domain/trades/trade-journal";

export default function PortfolioDashboard() {
  const [records, setRecords] = useState<readonly TradeJournalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void tradeJournalRepository.list()
      .then((items) => { if (active) setRecords(items); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load the local trade journal.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const stats = useMemo(() => {
    const wins = records.filter((record) => record.resultR > 0);
    const losses = records.filter((record) => record.resultR < 0);
    const netR = records.reduce((sum, record) => sum + record.resultR, 0);
    const grossWinR = wins.reduce((sum, record) => sum + record.resultR, 0);
    const grossLossR = Math.abs(losses.reduce((sum, record) => sum + record.resultR, 0));
    return {
      count: records.length,
      winRate: records.length ? wins.length / records.length * 100 : 0,
      netR,
      averageR: records.length ? netR / records.length : 0,
      profitFactor: grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? null : 0,
      best: records.length ? Math.max(...records.map((record) => record.resultR)) : null,
      worst: records.length ? Math.min(...records.map((record) => record.resultR)) : null,
    };
  }, [records]);

  const instrumentBreakdown = useMemo(() => {
    const grouped = new Map<string, { count: number; netR: number; wins: number }>();
    for (const record of records) {
      const current = grouped.get(record.instrumentId) ?? { count: 0, netR: 0, wins: 0 };
      current.count += 1;
      current.netR += record.resultR;
      if (record.resultR > 0) current.wins += 1;
      grouped.set(record.instrumentId, current);
    }
    return [...grouped.entries()].map(([symbol, value]) => ({ symbol, ...value }))
      .sort((a, b) => b.netR - a.netR);
  }, [records]);

  return (
    <div className="portfolio-dashboard">
      <section className="portfolio-intro surface">
        <div><span className="card-kicker">PERFORMANCE OVERVIEW</span><h2>Your trading statistics</h2><p>Calculated from completed trades saved in your local journal.</p></div>
        <span className="portfolio-r-unit">UNIT: R-MULTIPLE</span>
      </section>
      {loading ? <p className="journal-empty">Loading portfolio statistics…</p> : null}
      {error ? <p className="journal-error">{error}</p> : null}
      {!loading && !error ? (
        <>
          <section className="portfolio-stat-grid">
            <article className="portfolio-stat-card surface"><small>RECORDED TRADES</small><strong>{stats.count}</strong><span>Completed journal entries</span></article>
            <article className="portfolio-stat-card surface"><small>WIN RATE</small><strong>{stats.count ? stats.winRate.toFixed(1) + "%" : "—"}</strong><span>Wins ÷ all recorded trades</span></article>
            <article className="portfolio-stat-card surface"><small>NET RESULT</small><strong className={stats.netR > 0 ? "is-positive" : stats.netR < 0 ? "is-negative" : ""}>{stats.count ? (stats.netR > 0 ? "+" : "") + stats.netR.toFixed(2) + "R" : "—"}</strong><span>Sum of each trade's R result</span></article>
            <article className="portfolio-stat-card surface"><small>AVERAGE RESULT</small><strong>{stats.count ? (stats.averageR > 0 ? "+" : "") + stats.averageR.toFixed(2) + "R" : "—"}</strong><span>Average R per trade</span></article>
          </section>
          <section className="portfolio-detail-grid">
            <article className="surface portfolio-detail-card">
              <div className="journal-history-heading"><div><span className="card-kicker">RISK PERFORMANCE</span><h2>Trade quality</h2></div></div>
              <div className="portfolio-metric-row"><span>Profit factor</span><strong>{stats.profitFactor === null ? "∞" : stats.count ? stats.profitFactor.toFixed(2) : "—"}</strong></div>
              <div className="portfolio-metric-row"><span>Best trade</span><strong className="is-positive">{stats.best === null ? "—" : "+" + stats.best.toFixed(2) + "R"}</strong></div>
              <div className="portfolio-metric-row"><span>Worst trade</span><strong className="is-negative">{stats.worst === null ? "—" : stats.worst.toFixed(2) + "R"}</strong></div>
              <p className="portfolio-disclaimer">R-multiple statistics are not account equity or cash P&L. Commission, spread, swap, position size and broker contract specifications are not included.</p>
            </article>
            <article className="surface portfolio-detail-card">
              <div className="journal-history-heading"><div><span className="card-kicker">INSTRUMENTS</span><h2>By market</h2></div></div>
              {instrumentBreakdown.length ? instrumentBreakdown.map((item) => (
                <div className="portfolio-instrument-row" key={item.symbol}>
                  <div><strong>{item.symbol}</strong><small>{item.count} trades · {item.count ? (item.wins / item.count * 100).toFixed(0) : 0}% wins</small></div>
                  <b className={item.netR > 0 ? "is-positive" : item.netR < 0 ? "is-negative" : ""}>{item.netR > 0 ? "+" : ""}{item.netR.toFixed(2)}R</b>
                </div>
              )) : <p className="journal-empty">Your instrument breakdown will appear after you record trades.</p>}
            </article>
          </section>
        </>
      ) : null}
    </div>
  );
}
