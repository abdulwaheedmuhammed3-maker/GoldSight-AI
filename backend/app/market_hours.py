"""Exness XAUUSD trading-session calendar.

Times are sourced from the Exness instrument trading-hours schedule.
Exness changes XAUUSD hours with US daylight-saving time. All schedule
boundaries are evaluated in UTC; close-only periods are not entry-tradable.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc
NEW_YORK = ZoneInfo("America/New_York")


def _summer_schedule(now: datetime) -> bool:
    return now.astimezone(NEW_YORK).dst() != timedelta(0)


def _session_state(now: datetime) -> tuple[str, str]:
    """Return (state, phase) where state is OPEN or CLOSED."""
    now = now.astimezone(UTC)
    summer = _summer_schedule(now)
    weekday = now.weekday()  # Mon=0 ... Sun=6
    seconds = now.hour * 3600 + now.minute * 60 + now.second

    sunday_open = 22 * 3600 + (5 if summer else 5) * 60
    sunday_open = (21 if summer else 22) * 3600 + 5 * 60
    daily_close = (20 if summer else 21) * 3600 + 58 * 60
    daily_reopen = (22 if summer else 23) * 3600 + 2 * 60
    close_only_start = daily_reopen - 90

    if weekday == 5:  # Saturday
        return "CLOSED", "WEEKEND"
    if weekday == 6:  # Sunday
        close_only_start_sun = sunday_open - 210
        if seconds < close_only_start_sun:
            return "CLOSED", "WEEKEND"
        if seconds < sunday_open:
            return "CLOSED", "CLOSE_ONLY"
        return "OPEN", "TRADING"
    if weekday == 4:  # Friday
        return ("OPEN", "TRADING") if seconds < daily_close else ("CLOSED", "WEEKEND")
    # Monday through Thursday: daily maintenance break.
    if seconds < daily_close or seconds >= daily_reopen:
        return "OPEN", "TRADING"
    if seconds >= close_only_start:
        return "CLOSED", "CLOSE_ONLY"
    return "CLOSED", "DAILY_BREAK"


def xauusd_market_status(now: datetime | None = None) -> dict:
    """Describe the current Exness XAUUSD session and next entry-tradable open."""
    current = (now or datetime.now(UTC)).astimezone(UTC)
    state, phase = _session_state(current)
    next_open = None
    if state != "OPEN":
        # Minute stepping is sufficient for a UI countdown; round forward so
        # the returned time never claims the market opens before it actually does.
        candidate = current.replace(second=0, microsecond=0) + timedelta(minutes=1)
        for _ in range(8 * 24 * 60):
            if _session_state(candidate)[0] == "OPEN":
                next_open = candidate
                break
            candidate += timedelta(minutes=1)
    return {
        "market_status": "OPEN" if state == "OPEN" else "MARKET_CLOSED",
        "market_phase": phase,
        "next_open_at": next_open.isoformat().replace("+00:00", "Z") if next_open else None,
        "schedule_timezone": "UTC",
        "schedule_source": "Exness XAUUSD instrument trading hours",
    }
