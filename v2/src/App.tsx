import { useEffect, useState } from "react";
import MarketWatchCard from "./components/MarketWatchCard";
import MarketChartPanel from "./components/MarketChartPanel";
import FeedSettingsPanel from "./components/FeedSettingsPanel";
import SignalCentre from "./components/SignalCentre";
import JournalWorkspace from "./components/JournalWorkspace";
import PortfolioDashboard from "./components/PortfolioDashboard";
import type { SupportedTimeframe } from "./domain/market-data/market-data-engine";
import { getQuoteDisplayFreshness } from "./domain/market-data/quote-store";
import { getMarketSessionStatus } from "./domain/market-data/market-session";
import { useInstrumentMarketState } from "./hooks/use-market-data";
import { useVisibleInstrumentSymbols } from "./hooks/use-visible-instruments";
import { COMMODITY_DETAILS, COMMODITY_SYMBOLS } from "./domain/market-data/instrument-catalog";

const instruments = [
  { symbol: "EURUSD", accent: "violet", category: "FOREX" },
  { symbol: "GBPUSD", accent: "coral", category: "FOREX" },
  { symbol: "USDJPY", accent: "blue", category: "FOREX" },
  { symbol: "AUDUSD", accent: "mint", category: "FOREX" },
  { symbol: "USDCAD", accent: "gold", category: "FOREX" },
  { symbol: "USDCHF", accent: "violet", category: "FOREX" },
  { symbol: "NZDUSD", accent: "mint", category: "FOREX" },
  { symbol: "EURGBP", accent: "coral", category: "FOREX" },
  ...COMMODITY_SYMBOLS.map((symbol) => ({
    symbol,
    accent: COMMODITY_DETAILS[symbol].accent,
    category: COMMODITY_DETAILS[symbol].category,
  })),
  { symbol: "BTCUSD", accent: "blue", category: "CRYPTO" },
];

const navigation = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "markets", label: "Markets", icon: "markets" },
  { id: "signals", label: "Signals", icon: "signals" },
  { id: "portfolio", label: "Portfolio", icon: "portfolio" },
  { id: "journal", label: "Journal", icon: "journal" },
  { id: "news", label: "News", icon: "more" },
  { id: "settings", label: "Settings", icon: "settings" },
] as const;

type AppIconName = "home" | "markets" | "signals" | "portfolio" | "journal" | "more" | "settings";

function AppIcon({ name, className }: { name: AppIconName; className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === "home" ? (
        <>
          <path d="m3.2 10.8 8.8-7.2 8.8 7.2" />
          <path d="M5.5 9.2V20h13V9.2M9.3 20v-6.2h5.4V20" />
        </>
      ) : name === "markets" ? (
        <>
          <path d="M4 4v16h16" />
          <path d="M7 14V9m0 0V6m-1 3h2m4 5V8m0 0V4m-1 4h2m4 8v-5m0 0V9m-1 3h2" />
          <path d="m5.5 16.5 4-4 4 2 5-6" />
        </>
      ) : name === "signals" ? (
        <>
          <circle cx="12" cy="12" r="8.1" />
          <circle cx="12" cy="12" r="3.4" />
          <path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22" />
        </>
      ) : name === "portfolio" ? (
        <>
          <rect x="3" y="6.5" width="18" height="14" rx="2.8" />
          <path d="M7 6.5V5.2A2.2 2.2 0 0 1 9.2 3h5.6A2.2 2.2 0 0 1 17 5.2v1.3M3 11h18" />
          <path d="M15.5 14.5h2.8" />
        </>
      ) : name === "journal" ? (
        <>
          <path d="M6 3.5h13.5v17H6zM6 7H4.5v13.5H6" />
          <path d="M9.5 8h6.5M9.5 12h6.5M9.5 16h4.5" />
        </>
      ) : name === "settings" ? (
        <>
          <path d="M4 6h16M4 12h16M4 18h16" />
          <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
          <circle cx="11" cy="18" r="2" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <circle cx="5" cy="12" r="1.35" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.35" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

const pageDescriptions: Record<string, string> = {
  overview: "Live market prices, clear setups and one focused trading workspace.",
  markets: "Track your selected instruments, plus Gold and Bitcoin, without losing the last accepted quote.",
  signals: "Multi-timeframe analysis, setup reasoning and TP/SL outcome monitoring.",
  portfolio: "Review performance from your completed trades, measured in risk multiples.",
  journal: "Record executions, review decisions and learn from your trading history.",
  news: "A sourced market news feed is planned for the next build stage.",
  settings: "Connect permitted market-data feeds and manage your local workspace.",
};

function MarketGrid({ items = instruments }: { items?: (typeof instruments)[number][] }) {
  return (
    <section className="market-grid">
      {items.map((instrument) => (
        <MarketWatchCard
          key={instrument.symbol}
          symbol={instrument.symbol}
          accent={instrument.accent}
          category={instrument.category}
        />
      ))}
    </section>
  );
}

function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <section className="section-heading">
      <div><h2>{title}</h2><p>{description}</p></div>
      {action ? <button className="text-action" onClick={action.onClick} type="button">{action.label} <span>↗</span></button> : null}
    </section>
  );
}

function ComingSoon() {
  return (
    <section className="surface coming-soon-panel">
      <span className="coming-soon-icon">◉</span>
      <span className="card-kicker">PLANNED · SOURCE VERIFICATION</span>
      <h2>Market news</h2>
      <p>A sourced news reader with publication times and instrument relevance is planned for a later build stage.</p>
    </section>
  );
}

function MarketConnectionStatus({
  onOpenSettings,
  selectedSymbols,
}: {
  onOpenSettings: () => void;
  selectedSymbols: readonly string[];
}) {
  const [marketClock, setMarketClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setMarketClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const btc = useInstrumentMarketState("BTCUSD");
  const gold = useInstrumentMarketState("XAUUSD");
  const otherCommodityStates = [
    useInstrumentMarketState("XAGUSD"),
    useInstrumentMarketState("XPTUSD"),
    useInstrumentMarketState("XPDUSD"),
    useInstrumentMarketState("XALUSD"),
    useInstrumentMarketState("XCUUSD"),
    useInstrumentMarketState("XNIUSD"),
    useInstrumentMarketState("XPBUSD"),
    useInstrumentMarketState("XZNUSD"),
    useInstrumentMarketState("WTIUSD"),
    useInstrumentMarketState("UKOUSD"),
    useInstrumentMarketState("NATGAS"),
  ];
  const fxStates = [
    useInstrumentMarketState("EURUSD"),
    useInstrumentMarketState("GBPUSD"),
    useInstrumentMarketState("USDJPY"),
    useInstrumentMarketState("AUDUSD"),
    useInstrumentMarketState("USDCAD"),
    useInstrumentMarketState("USDCHF"),
    useInstrumentMarketState("NZDUSD"),
    useInstrumentMarketState("EURGBP"),
  ];
  const selectedSymbolSet = new Set(selectedSymbols);
  const commodityFxStates = [gold, ...otherCommodityStates, ...fxStates]
    .filter((state) => selectedSymbolSet.has(state.quote.instrumentId));

  const btcDisplayFreshness = getQuoteDisplayFreshness(btc.quote);
  const btcStatus = btcDisplayFreshness === "LIVE" || btcDisplayFreshness === "SNAPSHOT" || btcDisplayFreshness === "STALE"
    ? btcDisplayFreshness
    : btc.feedStatus === "CONNECTING"
      ? "CONNECTING"
      : btc.feedStatus === "CONNECTED"
        ? "WAITING DATA"
        : btc.feedStatus === "ERROR"
          ? "ERROR"
          : "OFFLINE";

  const commodityFxLiveCount = commodityFxStates.filter((state) =>
    getQuoteDisplayFreshness(state.quote) === "LIVE",
  ).length;
  const commodityFxSnapshotCount = commodityFxStates.filter((state) =>
    getQuoteDisplayFreshness(state.quote) === "SNAPSHOT",
  ).length;
  const commodityFxValidCount = commodityFxLiveCount + commodityFxSnapshotCount;
  const commodityFxSessionsOpen = commodityFxStates.filter((state) =>
    getMarketSessionStatus(state.quote.instrumentId, marketClock).isOpen,
  ).length;
  const commodityFxSessionCount = commodityFxStates.length;
  const commodityFxHasQuote = commodityFxStates.some((state) => state.quote.quote !== null);
  const commodityFxHasConnection = commodityFxStates.some((state) => state.feedStatus === "CONNECTED");
  const commodityFxHasError = commodityFxStates.some((state) => state.feedStatus === "ERROR");
  const commodityFxIsConnecting = commodityFxStates.some((state) => state.feedStatus === "CONNECTING");
  const commodityFxStatus = commodityFxStates.length === 0
    ? "NO SELECTION"
    : commodityFxSessionsOpen === 0
      ? "CLOSED"
      : commodityFxLiveCount === commodityFxStates.length
      ? "LIVE"
    : commodityFxSnapshotCount === commodityFxStates.length
      ? "SNAPSHOT"
      : commodityFxValidCount === commodityFxStates.length && commodityFxLiveCount > 0 && commodityFxSnapshotCount > 0
        ? "MIXED"
        : commodityFxValidCount > 0
          ? "PARTIAL"
          : commodityFxHasQuote
            ? "STALE"
            : commodityFxHasConnection
              ? "WAITING DATA"
              : commodityFxHasError
                ? "ERROR"
                : commodityFxIsConnecting
                  ? "CONNECTING"
                  : "KEY REQUIRED";

  return (
    <div className="data-connection-group" aria-label="Market data connection status">
      <button
        className={"data-connection-pill data-" + btcStatus.toLowerCase().replace(/\s+/g, "-")}
        type="button"
        onClick={onOpenSettings}
        title={btc.detail ?? "BTCUSD reference uses Binance Spot BTCUSDT (USDT-denominated)."} 
      >
        <i /> BTC {btcStatus}
      </button>
      <button
        className={"data-connection-pill data-" + commodityFxStatus.toLowerCase().replace(/\s+/g, "-")}
        type="button"
        onClick={onOpenSettings}
        title={
          "COMMODITY/FX validated live quotes: " + commodityFxLiveCount + "/" + commodityFxStates.length +
          "; fresh REST snapshots: " + commodityFxSnapshotCount + ". " +
          "Trading sessions open: " + commodityFxSessionsOpen + "/" + commodityFxSessionCount + ". " +
          "Commodity feeds: " + [gold, ...otherCommodityStates].map((state) => state.quote.freshness).join(", ") + ". " +
          "Forex feeds: " + fxStates.map((state) => state.quote.freshness).join(", ")
        }
      >
        <i /> {commodityFxStatus === "CLOSED" ? "FX/COM SESSIONS CLOSED" : "MARKETS " + commodityFxStatus}{commodityFxStatus === "PARTIAL" ? " " + commodityFxValidCount + "/" + commodityFxStates.length : ""}
      </button>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [activePage, setActivePage] = useState<string>("overview");
  const [activeTimeframe, setActiveTimeframe] = useState<SupportedTimeframe>("15m");
  const visibleInstrumentSymbols = useVisibleInstrumentSymbols();
  const visibleMarketInstruments = visibleInstrumentSymbols
    .map((symbol) => instruments.find((instrument) => instrument.symbol === symbol))
    .filter((instrument): instrument is (typeof instruments)[number] => Boolean(instrument));
  const homeWatchlist = visibleMarketInstruments;

  const currentPage = navigation.find((item) => item.id === activePage) ?? navigation[0];

  return (
    <div className={`app-shell theme-${theme}`}>
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => setActivePage("overview")}>
          <img className="brand-mark" src={import.meta.env.BASE_URL + "icons/tradesight.svg"} alt="" />
          <span>TradeSight</span>
          <span className="brand-version">2.0</span>
        </button>

        <div className="side-caption">TRADING WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              className={`nav-item ${activePage === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => setActivePage(item.id)}
              type="button"
              aria-current={activePage === item.id ? "page" : undefined}
            >
              <span className="nav-icon"><AppIcon name={item.icon} /></span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="local-card">
            <div className="local-card-icon">⌁</div>
            <strong>Local-first workspace</strong>
            <p>Your core workspace is designed to run on this device. Windows is optional.</p>
            <span className="local-status"><i /> DEVICE ENGINE</span>
          </div>
          <div className="privacy-line"><i /> Your local workspace</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-brand" type="button" onClick={() => setActivePage("overview")} aria-label="TradeSight home">
            <img src={import.meta.env.BASE_URL + "icons/tradesight.svg"} alt="" />
            <span>TradeSight</span>
            <span className="brand-version">2.0</span>
          </button>
          <div className="breadcrumb"><span>WORKSPACE</span><b>›</b><strong>{currentPage.label}</strong></div>
          <div className="top-actions">
            <MarketConnectionStatus
              onOpenSettings={() => setActivePage("settings")}
              selectedSymbols={visibleInstrumentSymbols.filter((symbol) => symbol !== "BTCUSD")}
            />
            <span className="top-status"><i /> LOCAL APP</span>
            <button
              className={"settings-button" + (activePage === "settings" ? " active" : "")}
              aria-label="Open Settings"
              aria-current={activePage === "settings" ? "page" : undefined}
              type="button"
              onClick={() => setActivePage("settings")}
            >
              <span className="settings-button-icon" aria-hidden="true"><AppIcon name="settings" /></span>
              <span>Settings</span>
            </button>
            <button className="theme-switch" onClick={() => setTheme(theme === "light" ? "dark" : "light")} type="button" aria-label="Toggle light and dark theme">
              {theme === "light" ? "☾" : "☀"}
            </button>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <div className="eyebrow">TRADESIGHT 2.0 · TRADING WORKSPACE</div>
              <h1>{activePage === "overview" ? "Market overview" : currentPage.label}</h1>
              <p>{pageDescriptions[activePage] ?? pageDescriptions.overview}</p>
            </div>
            {activePage === "overview" ? (
              <div className="heading-chip"><span className="chip-dot" /> BTC SPOT CONNECTS AUTOMATICALLY · COMMODITY/FX KEY REQUIRED</div>
            ) : null}
          </section>

          {activePage === "overview" ? (
            <>
              <section className="hero-grid">
                <div className="welcome-card">
                  <div className="hero-orbit orbit-one" />
                  <div className="hero-orbit orbit-two" />
                  <div className="hero-content">
                    <span className="hero-kicker">TRADESIGHT 2.0 · MARKET INTELLIGENCE</span>
                    <h2>Trade with clarity.<br /><em>Read the market better.</em></h2>
                    <p>Live market data, structured setups and transparent risk analysis — built around one trusted price stream.</p>
                    <span className="hero-pill"><i /> PRICE INTEGRITY FIRST</span>
                  </div>
                  <div className="hero-art" aria-hidden="true">
                    <div className="art-ring ring-a" />
                    <div className="art-ring ring-b" />
                    <div className="art-bar bar-a" /><div className="art-bar bar-b" /><div className="art-bar bar-c" /><div className="art-bar bar-d" />
                    <div className="art-line" />
                  </div>
                </div>

              </section>

              <SectionHeading
                title="Market watch"
                description="Your selected Forex pairs appear first, followed by commodities and BTCUSD. Change selections in Settings."
                action={{ label: "All instruments", onClick: () => setActivePage("markets") }}
              />
              <MarketGrid items={homeWatchlist} />
              <section className="workspace-grid">
                <MarketChartPanel timeframe={activeTimeframe} onTimeframeChange={setActiveTimeframe} />
                <SignalCentre />
              </section>
              <section className="bottom-grid">
                <article className="surface feature-card feature-blue">
                  <span className="feature-icon">◷</span><div><span className="card-kicker">MARKET DATA</span><h3>Last-known-good prices</h3><p>Refreshes never clear a valid quote. Stale data remains visible with its original timestamp.</p></div>
                </article>
                <article className="surface feature-card feature-mint">
                  <span className="feature-icon">♧</span><div><span className="card-kicker">NOTIFICATIONS</span><h3>TP1, TP2, TP3 and stop-loss alerts</h3><p>Get a separate notification whenever a tracked signal reaches TP1, TP2, TP3 or Stop Loss.</p></div>
                </article>
                <article className="surface feature-card feature-coral">
                  <span className="feature-icon">⌂</span><div><span className="card-kicker">DEVICE MODE</span><h3>Independent Android engine</h3><p>Core market analysis does not require your Windows PC to remain switched on.</p></div>
                </article>
              </section>
            </>
          ) : null}

          {activePage === "markets" ? (
            <>
              <SectionHeading title="Your instruments" description="Only symbols selected in Settings are shown here, alongside XAUUSD and BTCUSD." />
              <MarketGrid items={visibleMarketInstruments} />
              <section className="workspace-grid">
                <MarketChartPanel timeframe={activeTimeframe} onTimeframeChange={setActiveTimeframe} />
              </section>
            </>
          ) : null}

          {activePage === "signals" ? <SignalCentre /> : null}
          {activePage === "portfolio" ? <PortfolioDashboard /> : null}
          {activePage === "journal" ? <JournalWorkspace /> : null}
          {activePage === "news" ? <ComingSoon /> : null}
          {activePage === "settings" ? <FeedSettingsPanel /> : null}
        </div>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {[
          { id: "overview", label: "Home", icon: "home" },
          { id: "markets", label: "Markets", icon: "markets" },
          { id: "signals", label: "Signals", icon: "signals" },
          { id: "portfolio", label: "Portfolio", icon: "portfolio" },
          { id: "journal", label: "Journal", icon: "journal" },
          { id: "settings", label: "More", icon: "more" },
        ].map((item) => (
          <button className={activePage === item.id ? "active" : ""} key={item.id} onClick={() => setActivePage(item.id)} type="button" aria-current={activePage === item.id ? "page" : undefined}>
            <AppIcon name={item.icon as AppIconName} className="mobile-nav-icon" /><small>{item.label}</small>
          </button>
        ))}
      </nav>
    </div>
  );
}
