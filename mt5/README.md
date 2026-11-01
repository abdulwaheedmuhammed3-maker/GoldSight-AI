# TradeSight MT5 Bridge (read-only foundation)

This folder contains the first MT5 Expert Advisor foundation for TradeSight.

## Current capability

- Reads terminal connection state, terminal build, broker/company, server, account login, account currency and leverage.
- Shows the number of open positions.
- Optionally displays balance, equity and free margin when `EnableAccountSnapshot=true`.
- Refreshes on a timer and displays the snapshot on the MT5 chart.
- Does **not** send account data to TradeSight or any external server.
- Does **not** open, modify or close trades. There is no order-execution code.

Account login and broker/server details are still sensitive. Do not post screenshots publicly. Leave `EnableAccountSnapshot=false` unless you explicitly want those financial values visible on your local terminal.

## Install on Windows

1. Open MetaTrader 5.
2. Press **F4** to open MetaEditor.
3. In MetaEditor, open **File → Open Data Folder** if needed, then navigate to `MQL5/Experts`.
4. Copy `TradeSightBridge.mq5` into that folder.
5. Open the file in MetaEditor and press **F7** to compile.
6. Return to MT5, refresh **Navigator → Expert Advisors**, and attach **TradeSightBridge** to a chart.
7. Keep algorithmic trading disabled if you prefer; this EA does not need permission to trade.

## Important status

This is an on-terminal diagnostic foundation only. It is **not yet paired** with the TradeSight backend and does not provide remote monitoring. The next implementation stage is authenticated device pairing and a persistent, read-only telemetry API. Remote telemetry must not be enabled until token handling, transport security, storage and access controls are implemented and tested.

Never enter your broker trading password or investor password into TradeSight. The bridge should use a separate revocable device token when remote pairing is added.
