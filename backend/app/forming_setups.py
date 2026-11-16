"""Intrabar setup candidates kept separate from executable, completed-candle signals.

Candidates are process-local display state only. They never enter Setup History,
the push-notification outbox, or the demo execution pipeline.
"""
from __future__ import annotations

from datetime import datetime, timezone
from threading import RLock
from typing import Any

from app.market import analyze, completed_candles, normalize_candles

TIMEFRAME_SECONDS = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}
_LOCK = RLock()
_STATES: dict[tuple[str, str], dict[str, Any]] = {}
_MAX_STATES = 1000


def _signal_timestamp(signal: dict[str, Any] | None) -> int | None:
    if not isinstance(signal, dict):
        return None
    value = signal.get("signal_time")
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return int(stamp.timestamp())
    except (TypeError, ValueError, OverflowError):
        return None


def evaluate_forming_candidate(
    candles: list[dict[str, Any]],
    symbol: str,
    timeframe: str,
    spread: float | None,
    higher_timeframe_candles: list[dict[str, Any]] | None = None,
    *,
    now_ts: float | None = None,
) -> dict[str, Any]:
    """Analyze only a provider-supplied, currently forming candle for display.

    The same conservative analyzer is used, but all executable levels are
    removed and the result is always NO SETUP / FORMING.
    """
    seconds = TIMEFRAME_SECONDS.get(timeframe)
    if seconds is None:
        return {"candle_time": None, "signal": None}
    now = datetime.now(timezone.utc).timestamp() if now_ts is None else float(now_ts)
    ordered = normalize_candles(candles)
    forming = [
        bar for bar in ordered
        if int(bar["time"]) <= now < int(bar["time"]) + seconds
        and bar.get("closed") is not True
    ]
    if not forming:
        return {"candle_time": None, "signal": None}

    candle = forming[-1]
    candle_time = int(candle["time"])
    closed = completed_candles(ordered, timeframe, now_ts=now)
    if len(closed) < 40:
        return {"candle_time": candle_time, "signal": None}

    candidate = analyze(
        closed + [candle],
        symbol,
        timeframe,
        spread,
        higher_timeframe_candles,
        include_last_completed=True,
    )
    candidate_side = candidate.get("status")
    if candidate_side not in {"BUY", "SELL"}:
        candidate_side = candidate.get("candidate_side")
    if candidate_side not in {"BUY", "SELL"}:
        return {"candle_time": candle_time, "signal": None}

    progress = max(0.0, min(1.0, (now - candle_time) / seconds))
    side_label = "bullish" if candidate_side == "BUY" else "bearish"
    safe_signal = dict(candidate)
    safe_signal.update({
        "status": "NO SETUP",
        "side": "NO SETUP",
        "setup_state": "FORMING",
        "candidate_side": candidate_side,
        "signal_time": datetime.fromtimestamp(candle_time, timezone.utc).isoformat(),
        "signal_fresh": True,
        "signal_age_seconds": 0,
        "forming_candle_time": candle_time,
        "forming_candle_progress": round(progress, 4),
        "forming_price": candle["close"],
        "entry": None,
        "stop_loss": None,
        "take_profits": [],
        "rr": None,
        "confidence": None,
        "confidence_label": None,
        "trade_type": "NO TRADE",
        "news_context": None,
        "news_context_status": "NO_ACTIVE_SETUP",
        "reasons": [
            f"A preliminary {side_label} {candidate_side} pattern is developing on the live {timeframe} candle. The candle has not closed."
        ],
        "pending_conditions": list(candidate.get("pending_conditions") or []) + [
            f"Wait for the {timeframe} candle to close.",
            "The normal completed-candle structure, spread, higher-timeframe and risk checks must still pass.",
        ],
        "invalidation": (
            "This candidate is withdrawn if price action breaks the developing structure "
            "or the candle closes without passing the normal confirmation checks."
        ),
    })
    return {"candle_time": candle_time, "signal": safe_signal}


def update_forming_lifecycle(
    symbol: str,
    timeframe: str,
    observed_candle_time: int | None,
    latest_completed_time: int | None,
    forming_candidate: dict[str, Any] | None,
    confirmed_signal: dict[str, Any] | None,
    *,
    now_ts: float | None = None,
) -> dict[str, Any] | None:
    """Track FORMING -> CONFIRMED/INVALIDATED transitions per instrument/timeframe.

    State is intentionally process-local; a backend restart clears only these
    display candidates. Confirmed trades continue to use durable Setup History.
    """
    seconds = TIMEFRAME_SECONDS.get(timeframe)
    if seconds is None:
        return None
    now = datetime.now(timezone.utc).timestamp() if now_ts is None else float(now_ts)
    key = (symbol.upper(), timeframe)
    confirmed_time = _signal_timestamp(confirmed_signal)
    candidate_time = _signal_timestamp(forming_candidate)
    current_candidate = (
        forming_candidate
        if isinstance(forming_candidate, dict) and candidate_time is not None
        else None
    )

    with _LOCK:
        state = _STATES.get(key)

        if state and confirmed_time == state.get("candle_time"):
            state.update({
                "status": "CONFIRMED",
                "candidate_currently_valid": True,
                "updated_at": now,
                "reason": "The completed-candle signal passed the existing confirmation engine.",
            })

        if state and state.get("status") == "FORMING":
            candle_closed = (
                latest_completed_time is not None
                and latest_completed_time >= int(state["candle_time"])
                and confirmed_time != int(state["candle_time"])
            )
            newer_candle = (
                observed_candle_time is not None
                and observed_candle_time > int(state["candle_time"])
            )
            if candle_closed or newer_candle:
                state.update({
                    "status": "INVALIDATED",
                    "candidate_currently_valid": False,
                    "updated_at": now,
                    "reason": "The candle closed without a confirmed trade signal.",
                })

        if current_candidate:
            if candidate_time == observed_candle_time:
                if not state or candidate_time > int(state.get("candle_time", -1)):
                    state = {
                        "symbol": key[0],
                        "timeframe": timeframe,
                        "candle_time": candidate_time,
                        "side": current_candidate.get("candidate_side"),
                        "status": "FORMING",
                        "candidate_currently_valid": True,
                        "signal": current_candidate,
                        "updated_at": now,
                        "reason": "Live candle is still forming; confirmation is pending.",
                    }
                    _STATES[key] = state
                elif candidate_time == int(state.get("candle_time", -1)) and state.get("status") == "FORMING":
                    state.update({
                        "side": current_candidate.get("candidate_side"),
                        "candidate_currently_valid": True,
                        "signal": current_candidate,
                        "updated_at": now,
                    })
        elif state and state.get("status") == "FORMING":
            if observed_candle_time == int(state["candle_time"]):
                state.update({
                    "candidate_currently_valid": False,
                    "updated_at": now,
                    "reason": "The preliminary pattern is no longer present; waiting for candle close or renewed structure.",
                })

        # Bound memory and discard old terminal display states.
        if len(_STATES) > _MAX_STATES:
            oldest = sorted(_STATES.items(), key=lambda item: item[1].get("updated_at", 0))
            for old_key, _ in oldest[: len(_STATES) - _MAX_STATES]:
                _STATES.pop(old_key, None)

        if not state:
            return None
        age_after_close = now - (int(state["candle_time"]) + seconds)
        if state.get("status") == "CONFIRMED":
            if -30 <= age_after_close <= seconds * 2:
                return dict(state)
            _STATES.pop(key, None)
            return None
        if state.get("status") == "FORMING":
            return dict(state)
        if state.get("status") == "INVALIDATED" and -30 <= age_after_close <= seconds * 2:
            return dict(state)
        if state.get("status") == "INVALIDATED":
            _STATES.pop(key, None)
        return None


def reset_forming_lifecycle() -> None:
    """Test helper; never required by production startup."""
    with _LOCK:
        _STATES.clear()
