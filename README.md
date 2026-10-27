# GoldSight AI

A responsive XAUUSD market-analysis and forecasting platform for desktop and Android. The objective is to combine verified market data, price-action context, and probabilistic forecasts in a transparent decision-support interface.

> **Risk notice:** Forecasts are uncertain and do not guarantee trading profits. GoldSight AI is a research and decision-support tool, not financial advice. Never trade solely on a model signal.

## Planned technology stack

- **Frontend:** React, TypeScript, Vite, responsive CSS, installable Progressive Web App (PWA)
- **Charts:** TradingView Lightweight Charts
- **Backend:** Python, FastAPI, REST API and WebSockets
- **Storage:** PostgreSQL
- **Testing:** Frontend tests, Python API tests, and forecast evaluation/backtesting

## Core MVP

1. Live XAUUSD quote and candle updates from a configured market-data provider.
2. Interactive candlestick chart with timeframe selection.
3. Forecast cards that show direction/scenario, horizon, generated-at time, model version, and calibrated uncertainty where available.
4. Technical context: trend, volatility, key levels, and signal rationale.
5. Historical storage for candles, forecasts, and forecast evaluation.
6. Responsive desktop/mobile interface with PWA installation support.
7. Clear status indicators for stale feeds, disconnects, and service health.

## Architecture

```text
Market data provider
        |
        v
FastAPI ingestion and validation ---> PostgreSQL
        |                                  ^
        v                                  |
REST + WebSocket API                 candles / forecasts
        |
        v
React + TypeScript + Lightweight Charts
        |
        v
Desktop browser / Android browser / installed PWA
```

## Suggested project layout

```text
goldsight-ai/
├── frontend/              # React + TypeScript + Vite
├── backend/
│   ├── app/
│   │   ├── api/            # REST routes and WebSocket handlers
│   │   ├── core/           # Configuration and logging
│   │   ├── services/       # Market-data and forecasting services
│   │   ├── models/         # Database models
│   │   └── main.py         # FastAPI entry point
│   └── tests/
├── docs/                   # Architecture and provider notes
├── .env.example            # Safe placeholder environment variables only
├── .gitignore
└── README.md
```

## Data integrity and forecast evaluation

- Display the data provider and last-update timestamp.
- Detect missing, delayed, and disconnected feeds instead of silently treating old data as live.
- Keep historical backtests separate from live results.
- Prevent look-ahead bias and account for spread, fees, and slippage where relevant.
- Record forecast creation time, target horizon, model version, and eventual outcome.
- Do not present uncalibrated model scores as reliable probabilities.
- Treat model output as one input to analysis, not as certainty.

## Development roadmap

- [ ] Confirm market-data provider, licensing, latency, and API limits.
- [ ] Add frontend and FastAPI scaffolds.
- [ ] Add PostgreSQL schema and migrations.
- [ ] Implement validated quote/candle ingestion and WebSocket streaming.
- [ ] Build the responsive chart dashboard.
- [ ] Add baseline technical features and a reproducible forecasting baseline.
- [ ] Backtest and evaluate forecasts without look-ahead bias.
- [ ] Add tests, CI, and local/mobile-network setup instructions.
- [ ] Document deployment and operational monitoring.

## Local development

Detailed commands will be added when the application scaffolds and dependency files are committed. Store credentials in local environment variables; never commit API keys, broker credentials, database passwords, or production tokens.

## Contribution workflow

Use small, focused commits with clear messages. Update this README whenever supported features, architecture, or setup instructions change. Add tests for new behavior and keep secrets out of Git history.
