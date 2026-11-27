import { useState } from "react";
import MarketWatchCard from "./components/MarketWatchCard";
import MarketChartPanel from "./components/MarketChartPanel";
import FeedSettingsPanel from "./components/FeedSettingsPanel";
import SignalCentre from "./components/SignalCentre";
import type { SupportedTimeframe } from "./domain/market-data/market-data-engine";

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
];

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [activePage, setActivePage] = useState("overview");
  const [activeTimeframe, setActiveTimeframe] = useState<SupportedTimeframe>("15m");

  return (
    <div className={`app-shell theme-${theme}`}>
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => setActivePage("overview")}>
          <span className="brand-mark">T</span>
          <span>TradeSight</span>
          <span className="brand-version">2.0</span>
        </a>

        <div className="side-caption">TRADING WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              className={`nav-item ${activePage === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => setActivePage(item.id)}
              type="button"
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
            <p>Your core workspace is designed to run on this device.</p>
            <span className="local-status"><i /> BTC FEED CONNECTING</span>
          </div>
          <button className="nav-item settings-item" onClick={() => setActivePage("settings")} type="button">
            <span className="nav-icon">⚙</span><span>Settings</span>
          </button>
          <div className="privacy-line"><i /> Your local workspace</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>WORKSPACE</span><b>›</b><strong>{navigation.find((item) => item.id === activePage)?.label ?? "Settings"}</strong></div>
          <div className="top-actions">
            <span className="top-status"><i /> LOCAL APP</span>
            <button className="icon-button" aria-label="Notifications" type="button">♧</button>
            <button className="theme-switch" onClick={() => setTheme(theme === "light" ? "dark" : "light")} type="button" aria-label="Toggle light and dark theme">
              {theme === "light" ? "☾" : "☀"}
            </button>
            <div className="avatar">B</div>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <div className="eyebrow">YOUR MARKETS, IN ONE PLACE</div>
              <h1>Market overview</h1>
              <p>A clearer view of the market, with one consistent price source across every screen.</p>
            </div>
            <div className="heading-chip"><span className="chip-dot" /> BTC SPOT FEED · GOLD AND FX FEEDS TO FOLLOW</div>
          </section>

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

            <div className="integrity-card">
              <div className="card-topline"><span className="card-kicker">DATA INTEGRITY</span><span className="integrity-icon">✓</span></div>
              <h3>One price.<br />Everywhere.</h3>
              <p>Watchlist, chart and signal engine will share the same accepted quote and timestamp.</p>
              <div className="integrity-foot"><span className="integrity-bullet" /> CANONICAL QUOTE STORE</div>
            </div>
          </section>

          <section className="section-heading">
            <div><h2>Market watch</h2><p>Prices appear as soon as a provider returns a valid quote.</p></div>
            <button className="text-action" onClick={() => setActivePage("markets")} type="button">All instruments <span>↗</span></button>
          </section>

          <section className="market-grid">
            {instruments.map((instrument) => (
              <MarketWatchCard
                key={instrument.symbol}
                symbol={instrument.symbol}
                name={instrument.name}
                accent={instrument.accent}
                category={instrument.category}
              />
            ))}
          </section>

          <section className="workspace-grid">
            <MarketChartPanel
              timeframe={activeTimeframe}
              onTimeframeChange={setActiveTimeframe}
            />
            <FeedSettingsPanel />

            <SignalCentre />
          </section>

          <section className="bottom-grid">
            <article className="surface feature-card feature-blue">
              <span className="feature-icon">◷</span><div><span className="card-kicker">MARKET DATA</span><h3>Last-known-good prices</h3><p>Refreshes never clear a valid quote. Stale data remains visible with its timestamp.</p></div>
            </article>
            <article className="surface feature-card feature-mint">
              <span className="feature-icon">♧</span><div><span className="card-kicker">NOTIFICATIONS</span><h3>TP and stop-loss alerts</h3><p>Target and stop events will be tracked per setup, with duplicate alerts prevented.</p></div>
            </article>
            <article className="surface feature-card feature-coral">
              <span className="feature-icon">⌂</span><div><span className="card-kicker">DEVICE MODE</span><h3>Independent Android engine</h3><p>Core signals will not require your Windows PC to remain switched on.</p></div>
            </article>
          </section>
        </div>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navigation.slice(0, 5).map((item) => (
          <button className={activePage === item.id ? "active" : ""} key={item.id} onClick={() => setActivePage(item.id)} type="button">
            <span>{item.icon}</span><small>{item.label}</small>
          </button>
        ))}
      </nav>
    </div>
  );
}
