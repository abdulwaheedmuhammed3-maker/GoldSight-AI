# TradeSight MT5 Bridge — read-only

This is the first authenticated companion connection for MetaTrader 5. It sends a small, allow-listed terminal snapshot to the TradeSight API when remote telemetry is explicitly enabled.

## What it can report

- Broker/company, broker server, account login identifier, account currency and leverage
- MT5 terminal name/build and connection state
- Number of open positions
- Balance, equity and free margin only if `EnableAccountSnapshot=true`

It does **not** read or transmit broker passwords, investor passwords, open-position details, trade history or pending orders. It does not open, modify or close trades. No remote trade-command endpoint exists.

## Backend configuration (administrator)

The API requires a persistent PostgreSQL `DATABASE_URL`. Configure a new Render environment variable named `MT5_BRIDGE_ADMIN_KEY` with a long random secret (at least 32 characters). Keep it private; never put it in the frontend or the EA.

After the backend deploys, pair a terminal once from a trusted administrator machine. Example PowerShell:

```powershell
$admin = Read-Host "Paste MT5_BRIDGE_ADMIN_KEY"
$body = @{ device_name = "My MT5 Windows terminal" } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri "https://goldsight-ai-api.onrender.com/api/v1/mt5-bridge/pair" -Headers @{ "X-Bridge-Admin-Key" = $admin } -ContentType "application/json" -Body $body
$result
```

Copy `device_token` immediately. The backend stores only its SHA-256 hash, so the original token cannot be retrieved later. Do not share it or paste it into chats. If lost, revoke the device and pair again.

To list devices, use `GET /api/v1/mt5-bridge/devices` with the same `X-Bridge-Admin-Key` header. To revoke a device, send `DELETE /api/v1/mt5-bridge/devices/{device_id}` with that header.

## Install on Windows

1. Open MetaTrader 5 and press **F4** to open MetaEditor.
2. Use **File → Open Data Folder**, then open `MQL5/Experts`.
3. Copy `TradeSightBridge.mq5` into that folder.
4. Open the file in MetaEditor and press **F7** to compile.
5. Return to MT5, refresh **Navigator → Expert Advisors**, and attach **TradeSightBridge** to a chart.
6. In EA inputs, set `EnableRemoteTelemetry=true`, paste the one-time `DeviceToken`, and keep `EnableAccountSnapshot=false` unless you explicitly want balance/equity/free-margin transmitted.
7. In MT5, open **Tools → Options → Expert Advisors** and add the API host `https://goldsight-ai-api.onrender.com` to the allowed WebRequest URL list.
8. Confirm the EA chart comment reports telemetry enabled. The Experts log should report that telemetry was accepted after a successful heartbeat.

If WebRequest fails, check the Experts log, network connectivity, API health, and the allowed URL list. Do not disable HTTPS certificate validation.

## API

- `POST /api/v1/mt5-bridge/pair` — administrator-only token issuance
- `POST /api/v1/mt5-bridge/heartbeat` — bearer-token authenticated read-only snapshot
- `GET /api/v1/mt5-bridge/devices` — administrator-only device list (never returns tokens)
- `DELETE /api/v1/mt5-bridge/devices/{device_id}` — administrator-only token revocation

Pairing and telemetry require persistent PostgreSQL. If `DATABASE_URL` is missing, pairing/heartbeat returns a service-unavailable response rather than silently storing data in ephemeral files.

## Privacy and safety

Account login and broker/server metadata are sensitive. Keep the device list private. The EA transmits account login, broker/server metadata and open-position count when remote telemetry is enabled. Financial figures are only transmitted with the separate opt-in switch. Revoke a device if the terminal is retired or the token may have been exposed.

This bridge is strictly read-only. Trade execution is intentionally not implemented.
