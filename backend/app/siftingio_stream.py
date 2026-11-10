"""SiftingIO live XAUUSD WebSocket feed and UTC-aligned candle aggregator."""
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
STALE_AFTER_SECONDS = 30.0
FUTURE_TOLERANCE_SECONDS = 5.0
TIMEFRAME_SECONDS = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}
MAX_CANDLES_PER_TIMEFRAME = 500

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
_last_arrival_monotonic: float | None = None
_last_provider_tick_ms: int | None = None
_state.update({"connection_count": 0, "last_connected_at": None, "last_disconnected_at": None, "last_arrival_gap_seconds": None, "max_arrival_gap_seconds": 0.0, "last_provider_timestamp_gap_seconds": None, "max_provider_timestamp_gap_seconds": 0.0, "provider_timestamp_gap_events": 0, "validation_rejections_by_reason": {}})
_candles: dict[str, list[dict[str, Any]]] = {timeframe: [] for timeframe in TIMEFRAME_SECONDS}
_active_candles: dict[str, dict[str, Any]] = {}


def _set_state(**values: Any) -> None:
    with _lock:
        _state.update(values)
        _state["updated_at"] = datetime.now(timezone.utc).isoformat()


def _reject_tick(reason: str) -> None:
    with _lock:
        counts = dict(_state.get("validation_rejections_by_reason") or {})
        counts[reason] = int(counts.get(reason, 0)) + 1
        _state["validation_rejections_by_reason"] = counts
        _state["rejected_ticks"] = int(_state.get("rejected_ticks", 0)) + 1


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
            _reject_tick("invalid_timestamp")
            return None
        if isinstance(price, bool) or isinstance(bid, bool) or isinstance(ask, bool):
            _reject_tick("invalid_price_type")
            return None
        stamp_ms = int(stamp)
        values = [float(price), float(bid), float(ask)]
        if not all(math.isfinite(value) and value > 0 for value in values):
            _reject_tick("invalid_price_value")
            return None
        if values[2] < values[1]:
            _reject_tick("invalid_bid_ask_geometry")
            return None
        current_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
        age_seconds = (current_ms - stamp_ms) / 1000.0
        if age_seconds > STALE_AFTER_SECONDS:
            _reject_tick("stale_provider_timestamp")
            return None
        if age_seconds < -FUTURE_TOLERANCE_SECONDS:
            _reject_tick("future_provider_timestamp")
            return None
        with _lock:
            if stamp_ms <= _last_tick_ms:
                _reject_tick("duplicate_or_out_of_order_timestamp")
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
        _reject_tick("malformed_tick")
        return None


def _record_tick_as_candles(tick: dict[str, Any]) -> None:
    """Aggregate validated reference ticks into UTC-aligned OHLC bars.

    Bars are marked closed only after a later tick enters a subsequent bucket.
    Missing buckets are never fabricated; downstream continuity checks must
    reject gaps and these bars are not yet connected to the signal engine.
    """
    stamp = int(tick["timestamp_ms"] // 1000)
    price = float(tick["price"])
    completed_to_persist: list[tuple[str, dict[str, Any]]] = []
    with _lock:
        for timeframe, seconds in TIMEFRAME_SECONDS.items():
            bucket = (stamp // seconds) * seconds
            active = _active_candles.get(timeframe)
            if active is None:
                _active_candles[timeframe] = {
                    "time": bucket, "open": price, "high": price, "low": price,
                    "close": price, "volume": 0.0, "tick_count": 1,
                    "closed": False, "source": "SiftingIO WebSocket com ticks",
                }
                continue
            if bucket < int(active["time"]):
                continue
            if bucket == int(active["time"]):
                active["high"] = max(float(active["high"]), price)
                active["low"] = min(float(active["low"]), price)
                active["close"] = price
                active["tick_count"] = int(active["tick_count"]) + 1
                continue
            active["closed"] = True
            completed = dict(active)
            history = _candles[timeframe]
            history.append(completed)
            if len(history) > MAX_CANDLES_PER_TIMEFRAME:
                del history[:-MAX_CANDLES_PER_TIMEFRAME]
            completed_to_persist.append((timeframe, completed))
            _active_candles[timeframe] = {
                "time": bucket, "open": price, "high": price, "low": price,
                "close": price, "volume": 0.0, "tick_count": 1,
                "closed": False, "source": "SiftingIO WebSocket com ticks",
            }
    # Persist outside the stream lock so database latency cannot block tick processing.
    for timeframe, completed in completed_to_persist:
        try:
            from app.xau_candle_store import save_completed_candle
            save_completed_candle(timeframe, completed)
        except Exception:
            LOGGER.exception("Failed to persist completed XAUUSD candle timeframe=%s", timeframe)


def restore_xau_stream_candles() -> dict[str, int]:
    """Restore persisted completed bars before the WebSocket starts."""
    try:
        from app.xau_candle_store import load_recent_candles
        restored = load_recent_candles(MAX_CANDLES_PER_TIMEFRAME)
    except Exception:
        LOGGER.exception("Could not restore persisted XAUUSD candles")
        return {timeframe: 0 for timeframe in TIMEFRAME_SECONDS}
    counts: dict[str, int] = {}
    with _lock:
        for timeframe in TIMEFRAME_SECONDS:
            _candles[timeframe] = list(restored.get(timeframe, []))[-MAX_CANDLES_PER_TIMEFRAME:]
            counts[timeframe] = len(_candles[timeframe])
    return counts


def get_xau_stream_candles(timeframe: str, limit: int = 200) -> dict[str, Any]:
    """Return persisted/in-memory completed bars; no synthetic backfill."""
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported timeframe: {timeframe}")
    safe_limit = max(1, min(int(limit), MAX_CANDLES_PER_TIMEFRAME))
    with _lock:
        bars = [dict(item) for item in _candles[timeframe][-safe_limit:]]
        active = _active_candles.get(timeframe)
        active_copy = dict(active) if active is not None else None
    return {
        "symbol": SYMBOL,
        "provider": "SiftingIO WebSocket com ticks",
        "timeframe": timeframe,
        "candles": bars,
        "active_candle": active_copy,
        "completed_candles": len(bars),
        "note": "SiftingIO WebSocket tick aggregation only; completed bars are persisted, with no fabricated missing intervals.",
    }


def _send_application_pings(ws: websocket.WebSocketApp) -> None:
    """SiftingIO requires a JSON ping frame periodically, not only WS control pings."""
    while not _stop_event.wait(30):
        try:
            ws.send(json.dumps({"op": "ping"}))
        except Exception:
            return


def _on_open(ws: websocket.WebSocketApp) -> None:
    with _lock:
        _state["connection_count"] = int(_state.get("connection_count", 0)) + 1
        _state["last_connected_at"] = datetime.now(timezone.utc).isoformat()
    _set_state(connected=True, subscribed=False, status="CONNECTED", last_error=None)
    ws.send(json.dumps({"op": "subscribe", "product": "com", "symbols": [SYMBOL]}))
    threading.Thread(target=_send_application_pings, args=(ws,), name="siftingio-xau-app-ping", daemon=True).start()


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
    global _last_arrival_monotonic, _last_provider_tick_ms
    arrival_monotonic = time.monotonic()
    tick = _valid_tick(message)
    if tick is None:
        return
    with _lock:
        if _last_arrival_monotonic is not None:
            arrival_gap = max(0.0, arrival_monotonic - _last_arrival_monotonic)
            _state["last_arrival_gap_seconds"] = round(arrival_gap, 3)
            _state["max_arrival_gap_seconds"] = round(max(float(_state.get("max_arrival_gap_seconds", 0.0)), arrival_gap), 3)
        if _last_provider_tick_ms is not None:
            provider_gap = max(0.0, (tick["timestamp_ms"] - _last_provider_tick_ms) / 1000.0)
            _state["last_provider_timestamp_gap_seconds"] = round(provider_gap, 3)
            _state["max_provider_timestamp_gap_seconds"] = round(max(float(_state.get("max_provider_timestamp_gap_seconds", 0.0)), provider_gap), 3)
            if provider_gap > 10.0:
                _state["provider_timestamp_gap_events"] = int(_state.get("provider_timestamp_gap_events", 0)) + 1
        _last_arrival_monotonic = arrival_monotonic
        _last_provider_tick_ms = int(tick["timestamp_ms"])
    _record_tick_as_candles(tick)
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
    with _lock:
        _state["last_disconnected_at"] = datetime.now(timezone.utc).isoformat()
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
            app.run_forever()
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
