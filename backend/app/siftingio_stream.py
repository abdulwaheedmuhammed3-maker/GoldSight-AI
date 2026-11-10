"""SiftingIO live XAUUSD WebSocket observer.

This stage records validated live reference ticks only. It deliberately does not
turn ticks into OHLC candles or feed the signal engine; candle aggregation and
continuity integration are a separate, tested change.
"""
from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

import websocket

LOGGER = logging.getLogger("goldsight.siftingio_stream")
STREAM_URL = "wss://stream.sifting.io/ws/v1"
SYMBOL = "XAUUSD"
STALE_AFTER_SECONDS = 60.0
FUTURE_TOLERANCE_SECONDS = 5.0

_lock = threading.RLock()
_stop_event = threading.Event()
_thread: threading.Thread | None = None
_ws: websocket.WebSocketApp | None = None
_state: dict[str, Any] = {
    "status": "STOPPED",
    "provider": "SiftingIO WebSocket commodities reference stream",
    "symbol": SYMBOL,
    "connected": False,
    "subscribed": False,
    "last_tick": None,
    "last_tick_at": None,
    "last_tick_age_seconds": None,
    "ticks_received": 0,
    "rejected_ticks": 0,
    "last_error": None,
    "updated_at": None,
}
_last_tick_ms = 0


def _set_state(**values: Any) -> None:
    with _lock:
        _state.update(values)
        _state["updated_at"] = datetime.now(timezone.utc).isoformat()


def _valid_tick(message: dict[str, Any], now_ms: int | None = None) -> dict[str, Any] | None:
    """Validate SiftingIO tick frame; reject stale, future, malformed and replayed ticks."""
    global _last_tick_ms
    if message.get("f") != "tick" or str(message.get("s", "")).upper() != SYMBOL:
        return None
    try:
        stamp = message.get("t")
        price = message.get("p")
        bid = message.get("b")
        ask = message.get("a")
        if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
            return None
        if isinstance(price, bool) or isinstance(bid, bool) or isinstance(ask, bool):
            return None
        stamp_ms = int(stamp)
        values = [float(price), float(bid), float(ask)]
        if not all(math.isfinite(value) and value > 0 for value in values):
            return None
        if values[2] < values[1]:
            return None
        current_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
        age_seconds = (current_ms - stamp_ms) / 1000.0
        if age_seconds > STALE_AFTER_SECONDS or age_seconds < -FUTURE_TOLERANCE_SECONDS:
            return None
        with _lock:
            if stamp_ms <= _last_tick_ms:
                return None
            _last_tick_ms = stamp_ms
        return {
            "symbol": SYMBOL,
            "price": values[0],
            "bid": values[1],
            "ask": values[2],
            "timestamp_ms": stamp_ms,
            "timestamp": datetime.fromtimestamp(stamp_ms / 1000, timezone.utc).isoformat(),
            "age_seconds": max(0.0, round(age_seconds, 3)),
            "source": "SiftingIO WebSocket com tick",
        }
    except (TypeError, ValueError, OverflowError):
        return None


def _on_open(ws: websocket.WebSocketApp) -> None:
    _set_state(connected=True, subscribed=False, status="CONNECTED", last_error=None)
    ws.send(json.dumps({"op": "subscribe", "product": "com", "symbols": [SYMBOL]}))


def _on_message(ws: websocket.WebSocketApp, raw: str) -> None:
    try:
        message = json.loads(raw)
    except (TypeError, ValueError):
        _set_state(last_error="Received a non-JSON WebSocket frame.")
        return
    if not isinstance(message, dict):
        return
    frame = message.get("f")
    if frame == "ack":
        if message.get("op") == "subscribe":
            _set_state(subscribed=True, status="SUBSCRIBED")
        return
    if frame == "pong":
        return
    if frame == "error":
        _set_state(last_error=str(message.get("code", "provider_error")), status="ERROR")
        LOGGER.warning("SiftingIO stream error code=%s", message.get("code"))
        return
    if frame != "tick":
        return
    tick = _valid_tick(message)
    if tick is None:
        with _lock:
            _state["rejected_ticks"] += 1
        return
    with _lock:
        _state.update({
            "status": "LIVE",
            "subscribed": True,
            "last_tick": tick,
            "last_tick_at": tick["timestamp"],
            "last_tick_age_seconds": tick["age_seconds"],
            "ticks_received": int(_state["ticks_received"]) + 1,
            "last_error": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })


def _on_error(ws: websocket.WebSocketApp, error: Any) -> None:
    _set_state(connected=False, status="ERROR", last_error=type(error).__name__)
    LOGGER.warning("SiftingIO WebSocket error type=%s", type(error).__name__)


def _on_close(ws: websocket.WebSocketApp, close_status_code: Any, close_msg: Any) -> None:
    _set_state(connected=False, subscribed=False, status="DISCONNECTED")


def _run() -> None:
    global _ws
    retry_seconds = 1.0
    while not _stop_event.is_set():
        key = os.getenv("SIFTING_API_KEY", "").strip()
        if not key:
            _set_state(status="OFFLINE", connected=False, last_error="SIFTING_API_KEY is not configured.")
            return
        url = f"{STREAM_URL}?key={key}"
        app = websocket.WebSocketApp(
            url,
            on_open=_on_open,
            on_message=_on_message,
            on_error=_on_error,
            on_close=_on_close,
        )
        with _lock:
            _ws = app
        try:
            app.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as exc:
            _set_state(connected=False, status="ERROR", last_error=type(exc).__name__)
            LOGGER.warning("SiftingIO stream loop failed type=%s", type(exc).__name__)
        finally:
            with _lock:
                if _ws is app:
                    _ws = None
        if _stop_event.wait(retry_seconds):
            break
        retry_seconds = min(retry_seconds * 2, 30.0)
    _set_state(status="STOPPED", connected=False, subscribed=False)


def start_xau_stream() -> None:
    global _thread
    if not os.getenv("SIFTING_API_KEY", "").strip():
        _set_state(status="OFFLINE", connected=False, last_error="SIFTING_API_KEY is not configured.")
        return
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _stop_event.clear()
        _thread = threading.Thread(target=_run, name="siftingio-xau-stream", daemon=True)
        _thread.start()
    _set_state(status="CONNECTING", connected=False, subscribed=False, last_error=None)


def stop_xau_stream() -> None:
    global _thread, _ws
    _stop_event.set()
    with _lock:
        app = _ws
        thread = _thread
        _ws = None
        _thread = None
    if app is not None:
        try:
            app.close()
        except Exception:
            LOGGER.exception("Failed to close SiftingIO WebSocket cleanly")
    if thread is not None and thread.is_alive():
        thread.join(timeout=3)
    _set_state(status="STOPPED", connected=False, subscribed=False)


def get_xau_stream_status() -> dict[str, Any]:
    with _lock:
        result = dict(_state)
        if result.get("last_tick"):
            result["last_tick"] = dict(result["last_tick"])
    tick = result.get("last_tick")
    if tick:
        age = max(0.0, time.time() - (int(tick["timestamp_ms"]) / 1000.0))
        result["last_tick_age_seconds"] = round(age, 3)
        if age > STALE_AFTER_SECONDS:
            result["status"] = "STALE"
    return result
