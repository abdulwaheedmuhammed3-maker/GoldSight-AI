# TradeSight background worker

The worker runs the existing setup recorder independently of the FastAPI web
process. It scans markets, records setup outcomes, manages demo positions, and
retries pending setup/trade-outcome notifications. It also runs the existing
news-notification polling inside the recorder loop.

## Start command

Run from the `backend` directory:

```bash
pip install -r requirements.txt
python -m app.worker
```

## Required configuration

Configure the worker with the same environment variables as the API, especially:

- `DATABASE_URL` — the same PostgreSQL database used by the API
- Market-data provider credentials and settings (for example Exness API keys)
- Existing FCM and/or Web Push credentials and VAPID settings
- `SETUP_RECORDER_INTERVAL_SECONDS` (optional; minimum 60 seconds)

Do not commit credentials to GitHub or put them in frontend variables.

## Avoid running two recorders

After the worker is running reliably, set this variable on the API service:

```text
TRADESIGHT_RECORDER_ENABLED=false
```

The API's quote tracker and HTTP endpoints remain enabled. Only its embedded
setup recorder is disabled. Leave the variable unset or set it to `true` if
you are not running the separate worker.

The worker needs an always-on Python process. It can run on a VPS or another
background-worker host; it does not require a Render deployment. Both services
must point to the same database. Do not run multiple worker replicas against
the same account until distributed locking is added, because each replica
would scan and manage the same demo account.
