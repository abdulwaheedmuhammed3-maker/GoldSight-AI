import { useEffect, useState } from "react";
import MarketWatchCard from "./components/MarketWatchCard";
import MarketChartPanel from "./components/MarketChartPanel";
import FeedSettingsPanel from "./components/FeedSettingsPanel";
import SignalCentre from "./components/SignalCentre";
import JournalWorkspace from "./components/JournalWorkspace";
import PortfolioDashboard from "./components/PortfolioDashboard";
import type { SupportedTimeframe } from "./domain/market-data/market-data-engine";
import { useInstrumentMarketState } from "./hooks/use-market-data";
import {
  FEED_SELECTION_CHANGED_EVENT,
  readSelectedForexPairs,
} from "./domain/market-data/feed-preferences";

const instruments = [
  { symbol: "XAUUSD", name: "Gold / US Dollar", accent: "gold", category: "METALS" },
  { symbol: "BTCUSD", name: "Bitcoin / US Dollar", accent: "blue", category: "CRYPTO" },
  { symbol: "EURUSD", name: "Euro / US Dollar", accent: "violet", category: "FOREX" },
  { symbol: "GBPUSD", name: "Pound / US Dollar", accent: "coral", category: "FOREX" },
  { symbol: "USDJPY", name: "US Dollar / Yen", accent: "blue", category: "FOREX" },
  { symbol: "AUDUSD", name: "Aussie / US Dollar", accent: "mint", category: "FOREX" },
  { symbol: "USDCAD", name: "US Dollar / Canadian Dollar", accent: "gold", category: "FOREX" },
  { symbol: "USDCHF", name: "US Dollar / Swiss Franc", accent: "violet", category: "FOREX" },
  { symbol: "NZDUSD", name: "Kiwi / US Dollar", accent: "mint", category: "FOREX" },
  { symbol: "EURGBP", name: "Euro / Pound", accent: "coral", category: "FOREX" },
];

const navigation = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "markets", label: "Markets", icon: "⌁" },
  { id: "signals", label: "Signals", icon: "⌖" },
  { id: "portfolio", label: "Portfolio", icon: "◫" },
  { id: "journal", label: "Journal", icon: "▤" },
  { id: "news", label: "News", icon: "◉" },
  { id: "settings", label: "Settings", icon: "⚙" },
] as const;

const pageDescriptions: Record<string, string> = {
  overview: "Live market prices, clear setups and one focused trading workspace.",
  markets: "Track available instruments and open a chart without losing the last accepted quote.",
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
          name={instrument.name}
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

function MarketConnectionStatus({ onOpenSettings }: { onOpenSettings: () => void }) {
  const btc = useInstrumentMarketState("BTCUSD");
  const gold = useInstrumentMarketState("XAUUSD");
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
  const goldFxStates = [gold, ...fxStates];

  const btcStatus = btc.quote.freshness === "LIVE"
    ? "LIVE"
    : btc.quote.freshness === "STALE"
      ? "STALE"
      : btc.feedStatus === "CONNECTING"
        ? "CONNECTING"
        : btc.feedStatus === "CONNECTED"
          ? "WAITING DATA"
          : btc.feedStatus === "ERROR"
            ? "ERROR"
            : "OFFLINE";

  const goldFxHasLive = goldFxStates.some((state) =>
    state.quote.freshness === "LIVE" && state.quote.quote?.transport !== "REST_SNAPSHOT",
  );
  const goldFxHasSnapshot = goldFxStates.some((state) =>
    state.quote.quote?.transport === "REST_SNAPSHOT" &&
    (state.quote.quoteAgeMs ?? Number.POSITIVE_INFINITY) <= 7 * 60_000,
  );
  const goldFxHasQuote = goldFxStates.some((state) => state.quote.quote !== null);
  const goldFxHasConnection = goldFxStates.some((state) => state.feedStatus === "CONNECTED");
  const goldFxHasError = goldFxStates.some((state) => state.feedStatus === "ERROR");
  const goldFxIsConnecting = goldFxStates.some((state) => state.feedStatus === "CONNECTING");
  const goldFxStatus = goldFxHasLive && goldFxHasSnapshot
    ? "MIXED"
    : goldFxHasLive
      ? "LIVE"
      : goldFxHasSnapshot
        ? "SNAPSHOT"
        : goldFxHasQuote
          ? "STALE"
          : goldFxHasConnection
            ? "WAITING DATA"
            : goldFxHasError
              ? "ERROR"
              : goldFxIsConnecting
                ? "CONNECTING"
                : "KEY REQUIRED";

  return (
    <div className="data-connection-group" aria-label="Market data connection status">
      <button
        className={"data-connection-pill data-" + btcStatus.toLowerCase().replace(/\s+/g, "-")}
        type="button"
        onClick={onOpenSettings}
        title={btc.detail ?? "BTC uses the public Binance spot stream."}
      >
        <i /> BTC {btcStatus}
      </button>
      <button
        className={"data-connection-pill data-" + goldFxStatus.toLowerCase().replace(/\s+/g, "-")}
        type="button"
        onClick={onOpenSettings}
        title={
          "Gold: " + gold.quote.freshness + " (" + (gold.detail ?? "SiftingIO key required") + "). " +
          "Forex feeds: " + fxStates.map((state) => state.quote.freshness).join(", ")
        }
      >
        <i /> GOLD/FX {goldFxStatus}
      </button>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [activePage, setActivePage] = useState<string>("overview");
  const [activeTimeframe, setActiveTimeframe] = useState<SupportedTimeframe>("15m");
  const [selectedForexPairs, setSelectedForexPairs] = useState<string[]>(readSelectedForexPairs);

  useEffect(() => {
    const refreshSelectedPairs = () => setSelectedForexPairs(readSelectedForexPairs());
    window.addEventListener(FEED_SELECTION_CHANGED_EVENT, refreshSelectedPairs);
    window.addEventListener("storage", refreshSelectedPairs);
    return () => {
      window.removeEventListener(FEED_SELECTION_CHANGED_EVENT, refreshSelectedPairs);
      window.removeEventListener("storage", refreshSelectedPairs);
    };
  }, []);

  const coreHomeInstruments = instruments.filter(
    (instrument) => instrument.symbol === "XAUUSD" || instrument.symbol === "BTCUSD",
  );
  const selectedHomeForexInstruments = selectedForexPairs
    .map((symbol) => instruments.find((instrument) => instrument.symbol === symbol))
    .filter((instrument): instrument is (typeof instruments)[number] => Boolean(instrument));
  const homeWatchlist = [...coreHomeInstruments, ...selectedHomeForexInstruments];

  const currentPage = navigation.find((item) => item.id === activePage) ?? navigation[0];

  return (
    <div className={`app-shell theme-${theme}`}>
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => setActivePage("overview")}>
          <span className="brand-mark">T</span>
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
              <span className="nav-icon">{item.icon}</span>
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
          <div className="breadcrumb"><span>WORKSPACE</span><b>›</b><strong>{currentPage.label}</strong></div>
          <div className="top-actions">
            <MarketConnectionStatus onOpenSettings={() => setActivePage("settings")} />
            <span className="top-status"><i /> LOCAL APP</span>
            <button
              className={"settings-button" + (activePage === "settings" ? " active" : "")}
              aria-label="Open Settings"
              aria-current={activePage === "settings" ? "page" : undefined}
              type="button"
              onClick={() => setActivePage("settings")}
            >
              <span className="settings-button-icon" aria-hidden="true">⚙</span>
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
              <div className="heading-chip"><span className="chip-dot" /> BTC SPOT CONNECTS AUTOMATICALLY · GOLD/FX KEY REQUIRED</div>
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
                description="Gold and BTC stay pinned. Your five selected Forex pairs appear here; change them in Settings."
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
              <SectionHeading title="All instruments" description="Select an instrument in the chart workspace to inspect its price action." />
              <MarketGrid />
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
          { id: "overview", label: "Home", icon: "⌂" },
          { id: "markets", label: "Markets", icon: "⌁" },
          { id: "signals", label: "Signals", icon: "⌖" },
          { id: "portfolio", label: "Portfolio", icon: "◫" },
          { id: "journal", label: "Journal", icon: "▤" },
          { id: "settings", label: "More", icon: "☰" },
        ].map((item) => (
          <button className={activePage === item.id ? "active" : ""} key={item.id} onClick={() => setActivePage(item.id)} type="button" aria-current={activePage === item.id ? "page" : undefined}>
            <span>{item.icon}</span><small>{item.label}</small>
          </button>
        ))}
      </nav>
    </div>
  );
}
