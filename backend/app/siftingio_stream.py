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
MAX_ACTIVE_CANDLE_TICK_GAP_SECONDS = 30.0
ACTIVE_CANDLE_PERSIST_INTERVAL_SECONDS = 3.0

_lock = threading.RLock()
_stop_event = threading.Event()
_thread: threading.Thread | None = None
_active_persist_thread: threading.Thread | None = None
_active_persist_stop = threading.Event()
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
_state.update({"connection_count": 0, "last_connected_at": None, "last_disconnected_at": None, "last_arrival_gap_seconds": None, "max_arrival_gap_seconds": 0.0, "last_provider_timestamp_gap_seconds": None, "max_provider_timestamp_gap_seconds": 0.0, "provider_timestamp_gap_events": 0, "validation_rejections_by_reason": {}, "partial_candles_discarded": 0, "recovered_active_candles": 0, "active_candles_not_signal_eligible": 0})
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


def _new_active_candle(
    timeframe: str, bucket: int, price: float, tick_ms: int, *,
    signal_eligible: bool, integrity_reason: str | None = None,
    recovered_after_restart: bool = False,
) -> dict[str, Any]:
    return {
        "time": bucket, "open": price, "high": price, "low": price,
        "close": price, "volume": 0.0, "tick_count": 1,
        "last_tick_ms": tick_ms, "closed": False,
        "signal_eligible": signal_eligible,
        "integrity_status": "ELIGIBLE" if signal_eligible else "PARTIAL",
        "integrity_reason": integrity_reason,
        "recovered_after_restart": recovered_after_restart,
        "source": "SiftingIO WebSocket com ticks",
    }


def _active_snapshot() -> dict[str, dict[str, Any]]:
    with _lock:
        return {timeframe: dict(candle) for timeframe, candle in _active_candles.items()}


def _persist_active_snapshot() -> int:
    snapshot = _active_snapshot()
    if not snapshot:
        return 0
    try:
        from app.xau_candle_store import save_active_candles
        return save_active_candles(snapshot)
    except Exception as exc:
        LOGGER.warning("Could not persist active XAUUSD candle snapshots: %s", str(exc)[:220])
        return 0


def _active_persistence_loop() -> None:
    while not _active_persist_stop.wait(ACTIVE_CANDLE_PERSIST_INTERVAL_SECONDS):
        _persist_active_snapshot()


def _start_active_persistence_worker() -> None:
    global _active_persist_thread
    with _lock:
        if _active_persist_thread is not None and _active_persist_thread.is_alive():
            return
        _active_persist_stop.clear()
        _active_persist_thread = threading.Thread(
            target=_active_persistence_loop,
            name="siftingio-xau-active-candle-persistence",
            daemon=True,
        )
        _active_persist_thread.start()


def _record_tick_as_candles(tick: dict[str, Any]) -> None:
    """Aggregate validated ticks without promoting restart/gap-tainted bars.

    A candle that spans a server restart, begins after a cold start, or misses
    more than the allowed tick interval is chart-only. It is discarded at
    rollover instead of being persisted as a completed signal candle.
    """
    tick_ms = int(tick["timestamp_ms"])
    stamp = tick_ms // 1000
    price = float(tick["price"])
    completed_to_persist: list[tuple[str, dict[str, Any]]] = []
    with _lock:
        for timeframe, seconds in TIMEFRAME_SECONDS.items():
            bucket = (stamp // seconds) * seconds
            active = _active_candles.get(timeframe)

            if active is None:
                _active_candles[timeframe] = _new_active_candle(
                    timeframe, bucket, price, tick_ms,
                    signal_eligible=False,
                    integrity_reason="first_bucket_after_process_start",
                )
                _state["active_candles_not_signal_eligible"] = int(
                    _state.get("active_candles_not_signal_eligible", 0)
                ) + 1
                continue

            active_bucket = int(active["time"])
            if bucket < active_bucket:
                continue

            previous_tick_ms = int(active.get("last_tick_ms", tick_ms))
            tick_gap_seconds = max(0.0, (tick_ms - previous_tick_ms) / 1000.0)
            if tick_gap_seconds > MAX_ACTIVE_CANDLE_TICK_GAP_SECONDS:
                active["signal_eligible"] = False
                active["integrity_status"] = "PARTIAL"
                active["integrity_reason"] = "provider_tick_gap"
                _state["active_candles_not_signal_eligible"] = int(
                    _state.get("active_candles_not_signal_eligible", 0)
                ) + 1

            if bucket == active_bucket:
                active["high"] = max(float(active["high"]), price)
                active["low"] = min(float(active["low"]), price)
                active["close"] = price
                active["tick_count"] = int(active["tick_count"]) + 1
                active["last_tick_ms"] = tick_ms
                continue

            if bool(active.get("signal_eligible")):
                active["closed"] = True
                completed = dict(active)
                history = _candles[timeframe]
                history.append(completed)
                if len(history) > MAX_CANDLES_PER_TIMEFRAME:
                    del history[:-MAX_CANDLES_PER_TIMEFRAME]
                completed_to_persist.append((timeframe, completed))
            else:
                _state["partial_candles_discarded"] = int(
                    _state.get("partial_candles_discarded", 0)
                ) + 1

            # The new bucket is trustworthy only when the transition itself
            # was observed without a long provider-timestamp interruption.
            next_eligible = tick_gap_seconds <= MAX_ACTIVE_CANDLE_TICK_GAP_SECONDS
            _active_candles[timeframe] = _new_active_candle(
                timeframe, bucket, price, tick_ms,
                signal_eligible=next_eligible,
                integrity_reason=None if next_eligible else "provider_tick_gap_at_bucket_start",
            )
            if not next_eligible:
                _state["active_candles_not_signal_eligible"] = int(
                    _state.get("active_candles_not_signal_eligible", 0)
                ) + 1

    # Database work happens outside the stream lock and never blocks tick aggregation.
    for timeframe, completed in completed_to_persist:
        try:
            from app.xau_candle_store import save_completed_candle
            save_completed_candle(timeframe, completed)
        except Exception as exc:
            LOGGER.warning(
                "Failed to persist completed XAUUSD candle timeframe=%s error=%s",
                timeframe, str(exc)[:220],
            )


def restore_xau_stream_candles(now_ts: float | None = None) -> dict[str, int]:
    """Restore completed history and quarantine active bars from the old process."""
    global _last_tick_ms, _last_provider_tick_ms
    from datetime import datetime, timezone
    now = time.time() if now_ts is None else float(now_ts)
    from app.xau_candle_store import load_recent_candles, load_active_candles
    try:
        restored = load_recent_candles(MAX_CANDLES_PER_TIMEFRAME)
    except Exception:
        LOGGER.exception("Could not restore completed XAUUSD candle history")
        restored = {timeframe: [] for timeframe in TIMEFRAME_SECONDS}
    try:
        restored_active = load_active_candles()
    except Exception:
        # A failed active-state migration must not hide completed history.
        LOGGER.exception("Could not restore active XAUUSD candle snapshots")
        restored_active = {}

    counts: dict[str, int] = {}
    recovered = 0
    latest_tick_ms = 0
    with _lock:
        _active_candles.clear()
        for timeframe, seconds in TIMEFRAME_SECONDS.items():
            _candles[timeframe] = list(restored.get(timeframe, []))[-MAX_CANDLES_PER_TIMEFRAME:]
            counts[timeframe] = len(_candles[timeframe])

            snapshot = restored_active.get(timeframe)
            if not isinstance(snapshot, dict):
                continue
            try:
                candle_time = int(snapshot["time"])
                last_tick_ms = int(snapshot["last_tick_ms"])
                age = now - last_tick_ms / 1000.0
                current_bucket = (int(now) // seconds) * seconds
                opening, high, low, close = (
                    float(snapshot[key]) for key in ("open", "high", "low", "close")
                )
                valid_prices = all(math.isfinite(value) and value > 0 for value in (opening, high, low, close))
                valid_geometry = (
                    high >= max(opening, close, low)
                    and low <= min(opening, close, high)
                )
                valid_snapshot = (
                    candle_time >= 0 and candle_time % seconds == 0
                    and candle_time == current_bucket
                    and last_tick_ms > 0
                    and -FUTURE_TOLERANCE_SECONDS <= age <= STALE_AFTER_SECONDS
                    and valid_prices and valid_geometry
                    and int(snapshot.get("tick_count", 0)) > 0
                )
                if not valid_snapshot:
                    continue
                restored_candle = dict(snapshot)
                restored_candle.update({
                    "closed": False,
                    "signal_eligible": False,
                    "integrity_status": "PARTIAL",
                    "integrity_reason": "recovered_after_process_restart",
                    "recovered_after_restart": True,
                    "source": "SiftingIO WebSocket com ticks",
                })
                _active_candles[timeframe] = restored_candle
                latest_tick_ms = max(latest_tick_ms, last_tick_ms)
                recovered += 1
            except (KeyError, TypeError, ValueError, OverflowError):
                continue

        _last_tick_ms = latest_tick_ms
        _last_provider_tick_ms = latest_tick_ms or None
        _state["recovered_active_candles"] = recovered
        _state["partial_candles_discarded"] = 0
        _state["active_candles_not_signal_eligible"] = recovered

    LOGGER.info(
        "XAU_CANDLE_RESTORE completed_timeframes=%s recovered_active_timeframes=%s",
        counts, recovered,
    )
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
    _start_active_persistence_worker()
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _stop_event.clear()
        _thread = threading.Thread(target=_run, name="siftingio-xau-stream", daemon=True)
        _thread.start()
    _set_state(status="CONNECTING", connected=False, subscribed=False, last_error=None)


def stop_xau_stream() -> None:
    global _thread, _ws, _active_persist_thread
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

    # Flush one last active snapshot on graceful shutdown. It is quarantined on
    # the next boot and cannot be promoted into a completed signal candle.
    _active_persist_stop.set()
    with _lock:
        persist_thread = _active_persist_thread
        _active_persist_thread = None
    if persist_thread is not None and persist_thread.is_alive():
        persist_thread.join(timeout=3)
    _persist_active_snapshot()
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
