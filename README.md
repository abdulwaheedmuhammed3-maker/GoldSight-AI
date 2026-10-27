# GoldSight AI

A responsive XAUUSD market-analysis and forecasting platform for desktop and Android. This repository currently contains an initial full-stack scaffold; live market data and genuine predictive models are not yet connected.

> **Risk notice:** Forecasts are uncertain and do not guarantee trading profits. GoldSight AI is a research and decision-support tool, not financial advice. Never trade solely on a model signal.

## Stack
- Frontend: React, TypeScript, Vite, responsive CSS
- Charts: TradingView Lightweight Charts
- Backend: Python, FastAPI, REST and WebSockets (streaming implementation planned)
- Storage: PostgreSQL integration planned

## Run locally

### Backend
```bash
cd backend
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
API docs: http://127.0.0.1:8000/docs

Run backend tests from the `backend` directory:
```bash
pytest
```

### Frontend
In a second terminal:
```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0
```
Open the URL printed by Vite. On a phone connected to the same Wi-Fi, use the computer's LAN IP and Vite port. Configure `VITE_API_BASE_URL` in `.env.local` to point at the computer's LAN IP when testing from a phone.

## Current scaffold behavior
- Responsive dashboard and sample candlestick chart data clearly labelled as **DEMO**.
- FastAPI health endpoint and demo forecast endpoint.
- Basic API tests for health and demo behavior.
- No real-time provider, PostgreSQL connection, or production forecasting model is connected yet.

## Next steps
- [ ] Select market-data provider and confirm terms/API limits
- [ ] Connect live quotes and candle history
- [ ] Add PostgreSQL schema, migrations, and persistence
- [ ] Add WebSocket market updates
- [ ] Implement baseline forecasting and rigorous backtests
- [ ] Add frontend tests, CI, PWA install assets, and deployment guidance

## Security
Keep credentials in environment variables. Never commit API keys, broker credentials, database passwords, or production tokens.
