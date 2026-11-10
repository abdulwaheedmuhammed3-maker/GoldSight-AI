from datetime import datetime, timezone, timedelta
import asyncio
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
import hmac
from time import perf_counter
from fastapi import FastAPI, HTTPException, Query, Header, Body
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from app.market import MarketUnavailable, analyze, fetch_market, no_setup, normalize_candles, completed_candles, calculate_trend, mt5_connection_status, siftingio_history_diagnostics
from app.market_data_manager import start_market_data_manager, stop_market_data_manager, get_tracked_quote
from app.siftingio_stream import start_xau_stream, stop_xau_stream, get_xau_stream_status, get_xau_stream_candles, restore_xau_stream_candles
from app.xau_candle_store import initialize_xau_candle_store, xau_candle_store_status
from app.xau_candle_integrity import audit_persisted_xau_candles
from app.backtest import run_backtest
from app.walk_forward import run_walk_forward_validation, run_rolling_walk_forward_folds
from app.cost_sensitivity import run_cost_sensitivity
from app.regime_analysis import run_regime_analysis
from app.timeframes import aggregate_15m_to_45m
from app.exness import exness_historical_candles, exness_quote
from app.exness import _json_request
from app.market_hours import xauusd_market_status
from app.setup_history import database_configured, list_setups, is_symbol_in_setup_cooldown
from app.setup_performance import summarize_setup_performance
from app.setup_recorder import recorder_status, start_recorder, stop_recorder
from app.fundamentals import get_fundamental_news, get_fundamental_news_fast, classify_trade_context

from app.news_translation import translate_news
from app.opportunity_news import get_opportunity_news, start_news_monitor, stop_news_monitor
from app.risk_calculator import calculate_position_size
from app.currency_rates import get_currency_rates
from app.nigeria_economy import get_nigeria_economy
from app.ngx_intelligence import get_ngx_intelligence
from app.stock_intelligence import get_stock_intelligence
from app.stock_portfolio import initialize_portfolio_store, get_portfolio, deposit as stock_wallet_deposit, trade as stock_portfolio_trade
from app.demo_trading import process_demo_market
from app.mt5_bridge import initialize_bridge_store, pair_device, record_heartbeat, list_devices, revoke_device


LIVE_QUOTE_MAX_AGE_SECONDS = 60

# Maximum post-close delay accepted for a fresh setup. Values allow the
# recorder's staggered scan cadence, but reject delayed multi-hour signals.
SIGNAL_FRESHNESS_GRACE_SECONDS = {"5m": 600, "15m": 900, "30m": 1200, "1h": 1500, "4h": 4500}

def _signal_freshness_grace_seconds(timeframe: str) -> int:
    """Return the bounded post-close freshness grace for a supported timeframe."""
    return SIGNAL_FRESHNESS_GRACE_SECONDS.get(timeframe, 0)


def _batch_candle_feed_status(states: list[str], session_closed: bool = False) -> str:
    """Report LIVE only when every required timeframe has fresh completed candles."""
    if states and all(state == "LIVE" for state in states):
        return "LIVE"
    if any(state == "STALE" for state in states):
        return "STALE"
    if any(state == "LIVE" for state in states):
        return "PARTIAL"
    return "MARKET_CLOSED" if session_closed else "OFFLINE"



def _live_quote_age_seconds(market_data: dict, now: datetime | None = None) -> float | None:
    """Return age of the provider tick timestamp; unknown/malformed age stays unavailable."""
    updated_at = market_data.get("updated_at")
    if not isinstance(updated_at, str) or not updated_at.strip():
        return None
    try:
        stamp = datetime.fromisoformat(updated_at.strip().replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        current = now or datetime.now(timezone.utc)
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        age = (current.astimezone(timezone.utc) - stamp.astimezone(timezone.utc)).total_seconds()
    except (TypeError, ValueError, OverflowError):
        return None
    return age if age >= -5 else None


def _require_live_spread(signal: dict, market_data: dict) -> dict:
    """Charts may use candles, but new setups require a recent, timestamped broker tick."""
    quote_age = _live_quote_age_seconds(market_data)
    spread = market_data.get("spread")
    quote_offline = market_data.get("quote_status") == "OFFLINE"
    quote_stale = quote_age is None or quote_age > LIVE_QUOTE_MAX_AGE_SECONDS
    if spread is None or quote_offline or quote_stale:
        if quote_offline or spread is None:
            reason = "Fresh candles are available, but the broker tick/spread is unavailable; chart only, no new trade setup."
            status = market_data.get("quote_status", "UNAVAILABLE")
        elif quote_age is None:
            reason = "Broker quote timestamp is missing or invalid; chart only, no new trade setup."
            status = "STALE"
        else:
            reason = f"Broker quote is stale ({quote_age:.1f}s old; maximum {LIVE_QUOTE_MAX_AGE_SECONDS}s); chart only, no new trade setup."
            status = "STALE"
        signal = no_setup(reason)
        signal["quote_status"] = status
        signal["quote_age_seconds"] = quote_age
    return signal

app = FastAPI(title="GoldSight AI API", version="0.3.0", description="Live market data and explainable rule-based signals. No order execution.")

@app.get("/api/v1/providers/exness/diagnostics")
def exness_auth_diagnostics():
    """Perform fresh, read-only Exness signed requests; bypass discovery and instrument caches."""
    account_id = os.getenv("EXN_ACCOUNT_ID", "").strip()
    api_key_present = bool(os.getenv("EXN_API_KEY", "").strip())
    private_key_present = bool(os.getenv("EXN_PRIVATE_KEY", "").strip())
    configured_instrument = os.getenv("EXN_INSTRUMENT_XAUUSD", "XAUUSD").strip()

    result = {
        "provider": "Exness Trader API",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "credentials_present": {
            "api_key": api_key_present,
            "private_key": private_key_present,
            "account_id": bool(account_id),
        },
        "fresh_access_point_discovery": "NOT_CHECKED",
        "fresh_account_instrument_metadata": "NOT_CHECKED",
        "cache_bypassed": True,
        "xauusd_instrument": configured_instrument,
        "xauusd_available": None,
        "overall": "NOT_CONFIGURED",
        "note": "Fresh signed read-only requests; no orders are placed. Secret values and account details are never returned.",
    }
    if not (api_key_present and private_key_present and account_id.isdigit()):
        result["note"] = "Set all three Exness credentials in the backend environment. Values are not displayed."
        return result

    def classify_error(exc: MarketUnavailable) -> str:
        message = str(exc)
        if "provider_code=AUTH_INVALID_API_KEY" in message or "provider_code=1000" in message:
            return "INVALID_API_KEY_OR_KEY_ID"
        if "provider_code=AUTH_INVALID_SIGNATURE" in message or "provider_code=1001" in message:
            return "INVALID_SIGNATURE"
        if "HTTP 403" in message:
            return "PERMISSION_DENIED"
        if "EXN_PRIVATE_KEY format rejected" in message:
            return "PRIVATE_KEY_FORMAT_INVALID"
        return "AUTH_OR_REQUEST_FAILED"

    gateway = os.getenv("EXN_DISCOVERY_BASE_URL", "https://api.exness.com").strip()
    discovery_path = f"/v1/trading/access-point?account_id={account_id}"
    try:
        discovery = _json_request(gateway, discovery_path)
        access_point = discovery.get("access_point")
        if not isinstance(access_point, str) or not access_point.strip():
            raise MarketUnavailable("Exness host discovery did not return an access_point.")
        if not access_point.startswith(("https://", "http://")):
            access_point = "https://" + access_point
        access_point = access_point.rstrip("/")
        result["fresh_access_point_discovery"] = "PASS"
    except MarketUnavailable as exc:
        result["fresh_access_point_discovery"] = "FAIL"
        result["overall"] = "AUTHENTICATION_FAILED"
        result["error_category"] = classify_error(exc)
        result["error"] = str(exc)[:400]
        return result

    try:
        # Direct signed REST call deliberately avoids _available_instruments' 5-minute cache.
        metadata = _json_request(access_point, f"/v1/configuration/accounts/{account_id}/instruments")
        listed = metadata.get("instruments", [])
        names = {
            item if isinstance(item, str) else item.get("name", item.get("instrument", ""))
            for item in listed if isinstance(item, (str, dict))
        }
        names.discard("")
        result["fresh_account_instrument_metadata"] = "PASS"
        result["xauusd_available"] = configured_instrument in names
        result["overall"] = "PASS" if configured_instrument in names else "AUTHENTICATED_BUT_XAUUSD_UNAVAILABLE"
        if configured_instrument not in names:
            result["note"] = "Fresh authentication passed, but the configured gold instrument is not listed for this account. Set EXN_INSTRUMENT_XAUUSD to the exact account-listed name."
    except MarketUnavailable as exc:
        result["fresh_account_instrument_metadata"] = "FAIL"
        result["overall"] = "AUTHENTICATION_FAILED"
        result["error_category"] = classify_error(exc)
        result["error"] = str(exc)[:400]
    return result


@app.get("/api/v1/instruments/audit")
def instrument_market_data_audit(force_new: bool = Query(False)):
    """Return the latest audit by default; force_new=true explicitly starts a fresh audit."""
    from app.instrument_audit import start_or_get_audit
    return start_or_get_audit(force_new=force_new)


@app.get("/api/v1/instruments/audit/{audit_id}")
def instrument_market_data_audit_status(audit_id: str):
    """Return progress and results for a background market-data audit."""
    from app.instrument_audit import get_audit
    result = get_audit(audit_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Audit ID not found; start a new audit.")
    return result


@app.get("/api/v1/instruments/health")
def instrument_health():
    """Aggregate read-only freshness/provider health for every independently tracked instrument."""
    from app.market_data_manager import SYMBOLS, STALE_AFTER_SECONDS
    checked_at = datetime.now(timezone.utc)
    items = []
    for symbol in SYMBOLS:
        quote = get_tracked_quote(symbol)
        status = quote.get("status", "OFFLINE")
        age = quote.get("quote_age_seconds")
        if status == "LIVE" and (age is None or age > LIVE_QUOTE_MAX_AGE_SECONDS):
            status = "STALE"
        items.append({
            "symbol": symbol,
            "status": status,
            "provider": quote.get("provider"),
            "provider_symbol": quote.get("provider_symbol"),
            "price": quote.get("price"),
            "bid": quote.get("bid"),
            "ask": quote.get("ask"),
            "spread": quote.get("spread"),
            "digits": quote.get("digits"),
            "updated_at": quote.get("updated_at"),
            "quote_age_seconds": age,
            "detail": quote.get("detail"),
            "tradable_quote": bool(status == "LIVE" and quote.get("bid") is not None and quote.get("ask") is not None),
        })
    counts = {state: sum(item["status"] == state for item in items) for state in ("LIVE", "STALE", "OFFLINE")}
    return {
        "status": "ok",
        "checked_at": checked_at.isoformat(),
        "live_quote_max_age_seconds": LIVE_QUOTE_MAX_AGE_SECONDS,
        "tracker_stale_after_seconds": STALE_AFTER_SECONDS,
        "summary": counts,
        "instrument_count": len(items),
        "instruments": items,
        "note": "LIVE requires a validated fresh provider tick. Retained cached prices are shown only with their OFFLINE/STALE state and are not tradable quotes.",
    }

# The API is public/read-only, so allow the deployed static frontend even if a
# Render environment variable has not yet been synced from render.yaml.
# CORS_ORIGINS may add explicit origins; credentials are intentionally disabled.
configured_origins = [x.strip() for x in os.getenv("CORS_ORIGINS", "").split(",") if x.strip()]
default_origins = [
    "https://goldsight-ai-web.onrender.com",
    "https://tradesight-web.onrender.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    # Capacitor Android WebView origins (native bundled frontend).
    "http://localhost",
    "https://localhost",
    "capacitor://localhost",
]
origins = ["*"] if "*" in configured_origins else list(dict.fromkeys(default_origins + configured_origins))
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def start_setup_history_recorder():
    """Start optional services independently and log each startup stage.

    Market-data APIs must remain available even if a persistence subsystem is
    unavailable. Database-backed features report their own degraded status.
    """
    import logging
    logger = logging.getLogger("goldsight.startup")

    async def run_stage(name, operation, *, threaded=False):
        started = perf_counter()
        try:
            if threaded:
                await asyncio.to_thread(operation)
            else:
                result = operation()
                if asyncio.iscoroutine(result):
                    await result
            logger.info("STARTUP_STAGE_OK stage=%s duration_seconds=%.2f",
                        name, perf_counter() - started)
            return True
        except Exception:
            logger.exception("STARTUP_STAGE_FAILED stage=%s duration_seconds=%.2f",
                             name, perf_counter() - started)
            return False

    logger.info("STARTUP_BEGIN service=GoldSight AI API")
    await run_stage("mt5_bridge_store", initialize_bridge_store, threaded=True)
    await run_stage("stock_portfolio_store", initialize_portfolio_store, threaded=True)
    await run_stage("xau_candle_store", initialize_xau_candle_store, threaded=True)
    await run_stage("xau_candle_restore", restore_xau_stream_candles, threaded=True)
    await run_stage("market_data_manager", start_market_data_manager)
    await run_stage("siftingio_xau_websocket", start_xau_stream, threaded=True)
    await run_stage("setup_recorder", start_recorder)
    await run_stage("news_monitor", start_news_monitor)
    logger.info("STARTUP_COMPLETE service=GoldSight AI API")


@app.on_event("shutdown")
async def stop_setup_history_recorder():
    await asyncio.to_thread(stop_xau_stream)
    await stop_recorder()
    await stop_market_data_manager()
    await stop_news_monitor()




@app.get("/api/v1/stream/XAUUSD")
def xau_stream_status():
    """Read-only status for the SiftingIO XAUUSD live tick stream."""
    return get_xau_stream_status()


@app.get("/api/v1/stream/XAUUSD/candles")
def xau_stream_candles(
    timeframe: str = Query("15m", pattern="^(5m|15m|30m|1h|4h)$"),
    limit: int = Query(200, ge=1, le=500),
):
    """Read-only OHLC bars aggregated from validated live SiftingIO ticks."""
    payload = get_xau_stream_candles(timeframe, limit)
    payload["persistence"] = xau_candle_store_status()
    return payload


@app.get("/api/v1/stream/XAUUSD/diagnostics")
def xau_stream_candle_diagnostics(
    timeframe: str = Query("5m", pattern="^(5m|15m|30m|1h|4h)$"),
):
    """Compare live WebSocket candles with SiftingIO REST history without changing signal logic."""
    from app.market import TIMEFRAME_SECONDS, XAU_STREAM_CANDLE_MAX_AGE_SECONDS

    checked_at = datetime.now(timezone.utc)
    now_ts = checked_at.timestamp()
    stream_status = get_xau_stream_status()
    stream_payload = get_xau_stream_candles(timeframe, limit=500)
    bars = [
        row for row in stream_payload.get("candles", [])
        if isinstance(row, dict) and row.get("closed") is True
        and isinstance(row.get("time"), (int, float))
    ]
    bars.sort(key=lambda row: int(row["time"]))
    seconds = TIMEFRAME_SECONDS[timeframe]
    latest = bars[-1] if bars else None
    active = stream_payload.get("active_candle")
    latest_age = round(now_ts - int(latest["time"]), 3) if latest else None

    gaps = []
    recent_bars = bars[-100:]
    for previous, current in zip(recent_bars, recent_bars[1:]):
        previous_time = int(previous["time"])
        current_time = int(current["time"])
        missing = max(0, (current_time - previous_time) // seconds - 1)
        if missing:
            gaps.append({
                "after": datetime.fromtimestamp(previous_time, timezone.utc).isoformat(),
                "before": datetime.fromtimestamp(current_time, timezone.utc).isoformat(),
                "missing_intervals": missing,
            })

    rest = None
    rest_error = None
    try:
        rest = siftingio_history_diagnostics(timeframe, limit=240)
    except Exception as exc:
        rest_error = str(exc)[:300]

    rest_latest_at = rest.get("newest_valid_candle_at") if rest else None
    rest_latest_ts = (
        datetime.fromisoformat(rest_latest_at.replace("Z", "+00:00")).timestamp()
        if rest_latest_at else None
    )
    union_latest_ts = max(
        (stamp for stamp in (int(latest["time"]) if latest else None, int(rest_latest_ts) if rest_latest_ts is not None else None) if stamp is not None),
        default=None,
    )

    return {
        "symbol": "XAUUSD",
        "timeframe": timeframe,
        "checked_at": checked_at.isoformat(),
        "server_unix_timestamp": round(now_ts, 3),
        "tick_stream": {
            "status": stream_status.get("status"),
            "connected": stream_status.get("connected"),
            "subscribed": stream_status.get("subscribed"),
            "last_tick_at": stream_status.get("last_tick_at"),
            "last_tick_age_seconds": stream_status.get("last_tick_age_seconds"),
            "ticks_received": stream_status.get("ticks_received"),
            "rejected_ticks": stream_status.get("rejected_ticks"),
            "last_error": stream_status.get("last_error"),
        },
        "websocket_candles": {
            "completed_count": len(bars),
            "latest_completed_at": (
                datetime.fromtimestamp(int(latest["time"]), timezone.utc).isoformat()
                if latest else None
            ),
            "latest_completed_age_since_open_seconds": latest_age,
            "maximum_age_since_open_seconds": XAU_STREAM_CANDLE_MAX_AGE_SECONDS[timeframe],
            "latest_completed_tick_count": latest.get("tick_count") if latest else None,
            "latest_completed_source": latest.get("source") if latest else None,
            "active_candle": ({
                "open_time": datetime.fromtimestamp(int(active["time"]), timezone.utc).isoformat(),
                "age_since_open_seconds": round(now_ts - int(active["time"]), 3),
                "tick_count": active.get("tick_count"),
                "closed": active.get("closed"),
            } if isinstance(active, dict) and isinstance(active.get("time"), (int, float)) else None),
            "gap_count_in_last_100_completed": len(gaps),
            "recent_gaps": gaps[-20:],
            "freshness_gate_passes": bool(
                latest is not None and -30 <= latest_age <= XAU_STREAM_CANDLE_MAX_AGE_SECONDS[timeframe]
            ),
        },
        "rest_history": ({
            "newest_candle_at": rest.get("newest_valid_candle_at"),
            "newest_candle_age_seconds": rest.get("newest_valid_candle_age_seconds"),
            "valid_unique_rows": rest.get("valid_unique_rows"),
            "gap_count": rest.get("gap_count"),
            "history_pages_fetched": rest.get("history_pages_fetched"),
        } if rest else None),
        "rest_history_error": rest_error,
        "selection_diagnostic": {
            "latest_timestamp_after_websocket_rest_union": (
                datetime.fromtimestamp(union_latest_ts, timezone.utc).isoformat()
                if union_latest_ts is not None else None
            ),
            "note": "Union timestamp is diagnostic only; it does not certify the source of the candle selected by signal analysis.",
        },
        "persistence": xau_candle_store_status(),
        "signal_generation": "NOT_RUN",
        "note": "Diagnostics only. Does not alter candles, bypass freshness gates, or generate signals.",
    }


@app.get("/api/v1/market-data/XAUUSD/history-diagnostics")
def xau_history_diagnostics(
    timeframe: str = Query("1h", pattern="^(5m|15m|30m|1h|4h)$"),
    limit: int = Query(240, ge=40, le=1000),
):
    """Read-only inspection of raw SiftingIO historical XAUUSD bars."""
    try:
        return siftingio_history_diagnostics(timeframe, limit)
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception:
        logger.exception("XAU historical-feed diagnostics failed")
        raise HTTPException(status_code=503, detail="XAU historical-feed diagnostics unavailable")


@app.get("/api/v1/stream/XAUUSD/candles/integrity")
def xau_candle_integrity():
    """Read-only integrity audit of persisted XAUUSD candle history."""
    try:
        return audit_persisted_xau_candles()
    except Exception:
        logger.exception("XAU candle integrity audit failed")
        raise HTTPException(status_code=503, detail="XAU candle integrity audit unavailable")


@app.get("/api/v1/push/public-key")
def push_public_key():
    from app.push_notifications import service_status
    return service_status()


@app.post("/api/v1/push/subscribe")
def push_subscribe(subscription: dict):
    from app.push_notifications import save_subscription
    try:
        save_subscription(subscription)
        from app.push_notifications import retry_pending_setup_notifications
        retried = retry_pending_setup_notifications()
        return {"status": "subscribed", "pending_setup_notifications_retried": retried}
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/v1/push/test")
def push_test(subscription: dict):
    """Send a test notification only to this already-subscribed device."""
    from app.push_notifications import send_test_notification
    try:
        send_test_notification(subscription)
        return {"status": "sent", "message": "Test push accepted by the push provider for this device."}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.delete("/api/v1/push/subscribe")
def push_unsubscribe(payload: dict):
    from app.push_notifications import remove_subscription
    endpoint = payload.get("endpoint")
    if not isinstance(endpoint, str):
        raise HTTPException(status_code=400, detail="Subscription endpoint is required.")
    remove_subscription(endpoint)
    return {"status": "unsubscribed"}


@app.post("/api/v1/push/fcm/register")
def push_fcm_register(payload: dict):
    from app.fcm_notifications import register_device
    try:
        register_device(payload)
        return {"status": "registered", "message": "Android device token registered."}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/v1/push/fcm/test")
def push_fcm_test(payload: dict):
    from app.fcm_notifications import send_test
    try:
        send_test(payload.get("token"))
        return {"status": "sent", "message": "Firebase accepted the test notification."}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/notifications")
def notification_history(limit: int = Query(50, ge=1, le=100)):
    from app.push_notifications import list_notifications
    if not database_configured():
        raise HTTPException(status_code=503, detail="Notification history requires DATABASE_URL.")
    try:
        items = list_notifications(limit)
        return {"status": "ok", "count": len(items), "items": items}
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Notification history is unavailable.") from exc




@app.get("/api/v1/demo/sizing-preview")
def demo_sizing_preview_endpoint(
    symbol: str = Query(..., min_length=3, max_length=8),
    side: str = Query(..., pattern="^(BUY|SELL|buy|sell)$"),
    entry: float = Query(..., gt=0),
    stop_loss: float = Query(..., gt=0),
):
    """Read-only preview of fixed demo lot risk, NGN conversion and margin capacity."""
    from app.demo_trading import get_demo_account, demo_sizing_preview
    try:
        account = get_demo_account()
        used_margin = sum(
            float(trade.get("estimated_margin") or 0)
            for trade in account.get("trades", [])
            if trade.get("status") == "OPEN"
        )
        preview = demo_sizing_preview(
            symbol=symbol, side=side, entry=entry, stop_loss=stop_loss,
            balance=float(account["balance"]), used_margin=used_margin,
        )
        return {
            "status": "ok",
            "account_currency": account.get("currency", "NGN"),
            "account_balance_ngn": account["balance"],
            "open_positions": account["open_count"],
            "max_open_positions": account["max_open_trades"],
            "risk_per_trade_pct": account["risk_per_trade_pct"],
            "max_margin_utilization_pct": account["max_margin_utilization_pct"],
            "preview": preview,
            "note": "Read-only estimate; no demo position is opened. Market spread, commission, swap and slippage are not modeled.",
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/demo/account")
def demo_account():
    from app.demo_trading import get_demo_account
    try:
        return get_demo_account()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Demo account unavailable: {exc}") from exc


@app.post("/api/v1/demo/reset")
def demo_reset(x_demo_reset_token: str | None = Header(default=None, alias="X-Demo-Reset-Token")):
    # The demo account is shared at database level. Never expose a public reset.
    configured_token = os.getenv("DEMO_RESET_TOKEN", "")
    if len(configured_token) < 24:
        raise HTTPException(status_code=503, detail="Demo reset is locked. Configure a strong DEMO_RESET_TOKEN in the backend environment.")
    if not x_demo_reset_token or not hmac.compare_digest(x_demo_reset_token, configured_token):
        raise HTTPException(status_code=403, detail="Demo reset authorization failed.")
    from app.demo_trading import reset_demo_account
    try:
        return reset_demo_account()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Demo account reset failed: {exc}") from exc


@app.get("/api/v1/risk/profile")
def risk_profile():
    """GoldSight demo account and verified Exness XAUUSD sizing defaults."""
    return {
        "account_currency": "NGN",
        "account_balance": 300000,
        "leverage": 200,
        "default_risk_pct": 1,
        "maximum_risk_pct": 5,
        "max_open_demo_trades": 3,
        "symbols": {
            "XAUUSD": {
                "contract_size": 100, "minimum_volume": 0.01, "volume_step": 0.01, "maximum_volume": 1000,
                "digits": 2, "profit_currency": "USD", "margin_currency": "XAU",
                "margin_per_lot_usd_reference": 398.52,
                "margin_reference_side_values": {"buy": 398.52, "sell": 398.48},
                "margin_reference_is_indicative": True, "calculation_mode": "Forex"
            },
            "BTCUSD": {
                "contract_size": 1, "minimum_volume": 0.01, "volume_step": 0.01, "maximum_volume": 1000,
                "digits": 2, "profit_currency": "USD", "margin_currency": "BTC",
                "margin_per_lot_usd_reference": 234.54,
                "margin_reference_side_values": {"buy": 234.54, "sell": 234.36},
                "margin_reference_is_indicative": True, "calculation_mode": "Forex no leverage",
                "demo_execution_note": "Requires Exness BTCUSD quote feed; Binance BTCUSDT is analysis-only."
            },
            "EURUSD": {
                "contract_size": 100000, "minimum_volume": 0.01, "volume_step": 0.01, "maximum_volume": 1000,
                "digits": 5, "profit_currency": "USD", "margin_currency": "EUR",
                "calculation_mode": "Forex", "margin_uses_account_leverage": True
            },
            "GBPUSD": {
                "contract_size": 100000, "minimum_volume": 0.01, "volume_step": 0.01, "maximum_volume": 1000,
                "digits": 5, "profit_currency": "USD", "margin_currency": "GBP",
                "calculation_mode": "Forex", "margin_uses_account_leverage": True
            }
        },
        "fx_conversion": "Demo sizing prefers configured broker USD-to-NGN conversion; if unavailable it uses a clearly labelled public reference estimate, never an execution or remittance quote."
    }


@app.post("/api/v1/risk/position-size")
def risk_position_size(payload: dict):
    """Calculate broker-configurable CFD volume; does not submit an order."""
    try:
        result = calculate_position_size(
            symbol=str(payload.get("symbol", "")),
            side=str(payload.get("side", "")),
            # Preserve JSON types until the calculator validates them. In Python,
            # bool is a subclass of int, and float(True) would bypass its guard.
            balance=payload.get("balance"),
            risk_pct=payload.get("risk_pct", 1),
            entry=payload.get("entry"),
            stop_loss=payload.get("stop_loss"),
            leverage=payload.get("leverage", 200),
            contract_size=payload.get("contract_size"),
            quote_to_account_rate=payload.get("quote_to_account_rate"),
            volume_step=payload.get("volume_step", 0.01),
            min_volume=payload.get("min_volume", 0.01),
            max_volume=payload.get("max_volume", 1000),
            margin_per_lot_quote=payload.get("margin_per_lot_quote"),
        )
        return result
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc



@app.get("/api/v1/currencies/{base_currency}")
def currency_rates(base_currency: str):
    """Latest reference FX rates for all currencies supported by the provider."""
    try:
        return get_currency_rates(base_currency)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

@app.get("/api/v1/setups/recorder-status")
def setup_recorder_status():
    return recorder_status()


@app.get("/api/v1/setups/history")
def setup_history(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    if not database_configured():
        raise HTTPException(status_code=503, detail="Persistent setup history is not configured. Set DATABASE_URL to a persistent PostgreSQL database.")
    try:
        items = list_setups(limit, offset)
        return {"status": "ok", "count": len(items), "items": items, "limit": limit, "offset": offset}
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Setup history database is unavailable.") from exc

@app.post("/api/v1/admin/setup-audit/exness-candles")
def export_exness_setup_audit_candles(
    payload: dict = Body(...),
    x_audit_token: str | None = Header(default=None, alias="X-GoldSight-Audit-Token"),
):
    """Export broker-origin candles for offline replay; read-only and token-gated."""
    configured_token = os.getenv("GOLDSIGHT_AUDIT_TOKEN", "").strip()
    if len(configured_token) < 32:
        raise HTTPException(status_code=503, detail="Audit export is locked. Configure a strong GOLDSIGHT_AUDIT_TOKEN in the backend environment.")
    if not x_audit_token or not hmac.compare_digest(x_audit_token, configured_token):
        raise HTTPException(status_code=403, detail="Audit export authorization failed.")
    from app.setup_audit_export import build_exness_candle_archive
    try:
        archive = build_exness_candle_archive(payload)
        return StreamingResponse(
            iter([archive]),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="exness_setup_audit_candles.zip"',
                     "Cache-Control": "no-store"},
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        # Avoid leaking provider auth material or server configuration to clients.
        raise HTTPException(status_code=503, detail="Exness audit candle export failed. Check backend provider configuration.") from exc


@app.get("/api/v1/setups/performance")
def setup_performance(limit: int = Query(200, ge=1, le=200)):
    """Summarize tracked TP/SL outcomes among the most recent saved setups."""
    if not database_configured():
        raise HTTPException(status_code=503, detail="Persistent setup history is not configured. Set DATABASE_URL to a persistent PostgreSQL database.")
    try:
        items = list_setups(limit)
        summary = summarize_setup_performance(items)
        return {
            "status": "ok",
            "records_scanned": len(items),
            "scope": "Most recent saved setup records; bounded by limit.",
            **summary,
        }
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Setup performance database is unavailable.") from exc



@app.get("/api/v1/nigeria/economy")
def nigeria_economy():
    """Annual Nigeria macro trends and indicative NGN/USD reference rate."""
    return get_nigeria_economy()


@app.get("/api/v1/stocks/intelligence")
def stock_intelligence(country: str = Query("NG", pattern="^(NG|US|GB|CA|ZA|IN|DE|AU)$"), refresh: bool = False):
    """Multi-country signals-only equity research; never places orders."""
    try:
        return get_stock_intelligence(country=country, refresh=refresh)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/stocks/portfolio")
def stocks_portfolio(country: str = Query("NG", pattern="^(NG|US|GB|CA|ZA|IN|DE|AU)$"),
                     x_portfolio_key: str = Header(..., alias="X-Portfolio-Key", min_length=32)):
    try:
        return get_portfolio(x_portfolio_key,country)
    except (ValueError,RuntimeError) as exc:
        raise HTTPException(status_code=503 if isinstance(exc,RuntimeError) else 422,detail=str(exc)) from exc

@app.post("/api/v1/stocks/portfolio/deposit")
def stocks_portfolio_deposit(payload: dict = Body(...),
                             x_portfolio_key: str = Header(..., alias="X-Portfolio-Key", min_length=32)):
    try:
        return stock_wallet_deposit(x_portfolio_key,payload.get("country","NG"),payload.get("amount"),payload.get("note"))
    except (ValueError,TypeError) as exc:
        raise HTTPException(status_code=422,detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503,detail=str(exc)) from exc

@app.post("/api/v1/stocks/portfolio/trade")
def stocks_portfolio_trade(payload: dict = Body(...),
                           x_portfolio_key: str = Header(..., alias="X-Portfolio-Key", min_length=32)):
    try:
        return stock_portfolio_trade(x_portfolio_key,payload.get("country","NG"),payload.get("ticker"),payload.get("company"),payload.get("side"),payload.get("quantity"),payload.get("price"),payload.get("fees",0),payload.get("note"),payload.get("stop_loss"))
    except (ValueError,TypeError) as exc:
        raise HTTPException(status_code=422,detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503,detail=str(exc)) from exc

@app.get("/api/v1/ngx/intelligence")
def ngx_intelligence(refresh: bool = False):
    """Read-only NGX watchlist and conservative research scores; no order execution."""
    return get_ngx_intelligence(force=refresh)


@app.get("/api/v1/fundamentals/news")
def fundamental_news(
    limit: int = Query(30, ge=1, le=100),
    all_headlines: bool = Query(False, alias="all"),
    refresh: bool = False,
):
    """Curated RSS headlines from the trailing 24 hours; supports all retained items."""
    return get_fundamental_news_fast(limit=None if all_headlines else limit, force_refresh=refresh)




class NewsTranslationRequest(BaseModel):
    title: str = Field(min_length=1, max_length=700)
    summary: str = Field(default="", max_length=700)
    source_language: str = Field(default="autodetect", max_length=12)


@app.post("/api/v1/fundamentals/news/translate")
def translate_fundamental_news(request: NewsTranslationRequest):
    """Translate a headline and short summary on demand; original publisher link remains client-side."""
    try:
        return {"status": "translated", **translate_news(request.title, request.summary, request.source_language)}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/v1/opportunities/news")
def opportunity_news(limit: int = Query(60, ge=1, le=150), refresh: bool = False):
    """Curated technology, web-development and remote-career headlines."""
    return get_opportunity_news(limit=limit, force_refresh=refresh)

@app.get("/api/v1/opportunities/news/stream")
async def opportunity_news_stream():
    """Server-sent events: push feed snapshots whenever the background scan changes."""
    async def events():
        last_item_ids = None
        try:
            while True:
                snapshot = await asyncio.to_thread(get_opportunity_news, 150, False)
                item_ids = tuple(item.get("id") for item in snapshot.get("items", []))
                if item_ids != last_item_ids:
                    last_item_ids = item_ids
                    yield "event: news\\ndata: " + json.dumps(snapshot, separators=(",", ":")) + "\\n\\n"
                else:
                    yield ": keep-alive\\n\\n"
                await asyncio.sleep(3)
        except asyncio.CancelledError:
            return
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control":"no-cache", "X-Accel-Buffering":"no"})


@app.get("/")
def root():
    return {"name": "GoldSight AI API", "docs": "/docs", "status": "ready"}

@app.post("/api/v1/mt5-bridge/pair")
def mt5_bridge_pair(
    payload: dict = Body(...),
    x_bridge_admin_key: str | None = Header(default=None, alias="X-Bridge-Admin-Key"),
):
    """Create a one-time device token. Requires an administrator secret; never accepts broker passwords."""
    device_name = payload.get("device_name", "")
    if not isinstance(device_name, str):
        raise HTTPException(status_code=422, detail="Device name must be text.")
    try:
        return pair_device(x_bridge_admin_key or "", device_name)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/api/v1/mt5-bridge/heartbeat")
def mt5_bridge_heartbeat(
    payload: dict = Body(...),
    authorization: str | None = Header(default=None, alias="Authorization"),
):
    """Accept allow-listed read-only terminal metadata from a paired EA."""
    token = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else ""
    try:
        return record_heartbeat(token, payload)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/mt5-bridge/status")
def mt5_bridge_status(authorization: str | None = Header(default=None, alias="Authorization")):
    """Return the paired terminal's latest read-only snapshot to its token holder."""
    from app.mt5_bridge import device_status
    token = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else ""
    try:
        return device_status(token)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/mt5-bridge/devices")
def mt5_bridge_devices(
    x_bridge_admin_key: str | None = Header(default=None, alias="X-Bridge-Admin-Key"),
):
    """List paired terminals without exposing device tokens."""
    import secrets
    configured = os.getenv("MT5_BRIDGE_ADMIN_KEY", "").strip()
    if len(configured) < 32 or not x_bridge_admin_key or not secrets.compare_digest(x_bridge_admin_key, configured):
        raise HTTPException(status_code=403, detail="Bridge administration authorization failed.")
    try:
        return {"status": "ok", "devices": list_devices()}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.delete("/api/v1/mt5-bridge/devices/{device_id}")
def mt5_bridge_revoke(
    device_id: str,
    x_bridge_admin_key: str | None = Header(default=None, alias="X-Bridge-Admin-Key"),
):
    """Revoke a paired device token immediately."""
    try:
        changed = revoke_device(x_bridge_admin_key or "", device_id)
        if not changed:
            raise HTTPException(status_code=404, detail="Active bridge device not found.")
        return {"status": "revoked", "device_id": device_id}
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/v1/mt5/status")
def mt5_status():
    """Read-only MT5 terminal diagnostic; no account credentials or balances returned."""
    if os.getenv("MARKET_DATA_PROVIDER", "exness").strip().lower() != "mt5":
        return {
            "provider": "Exness MT5 terminal",
            "status": "NOT_SELECTED",
            "message": "Set MARKET_DATA_PROVIDER=mt5 on the Windows backend.",
            "read_only": True,
            "order_execution_enabled": False,
        }
    try:
        return mt5_connection_status()
    except MarketUnavailable as exc:
        return {
            "provider": "Exness MT5 terminal",
            "status": "OFFLINE",
            "terminal_connected": False,
            "detail": str(exc),
            "read_only": True,
            "order_execution_enabled": False,
        }


@app.get("/api/v1/provider/status")
def provider_status():
    """Safe read-only diagnostics: report whether provider credentials are present, never their values."""
    provider = os.getenv("MARKET_DATA_PROVIDER", "exness").strip().lower()
    if provider == "exness":
        required = ("EXN_API_KEY", "EXN_PRIVATE_KEY", "EXN_ACCOUNT_ID")
        missing = [name for name in required if not os.getenv(name, "").strip()]
        return {
            "provider": "Exness Trader API",
            "configured": not missing,
            "credentials_present": {name: bool(os.getenv(name, "").strip()) for name in required},
            "missing_variables": missing,
            "note": "Presence-only check. This does not validate credentials or confirm that instruments are enabled."
        }
    if provider == "oanda":
        required = ("OANDA_API_TOKEN", "OANDA_ACCOUNT_ID")
        missing = [name for name in required if not os.getenv(name, "").strip()]
        return {
            "provider": "OANDA v20 API",
            "configured": not missing,
            "credentials_present": {name: bool(os.getenv(name, "").strip()) for name in required},
            "missing_variables": missing,
            "note": "Presence-only check. This does not validate credentials or instrument access."
        }
    if provider == "mt5":
        return {"provider": "MetaTrader 5 terminal", "configured": False, "note": "Render cloud service cannot access a locally installed MT5 terminal unless a separate bridge is hosted."}
    return {"provider": provider, "configured": False, "note": "Unsupported MARKET_DATA_PROVIDER value."}


@app.get("/api/v1/provider/verify")
def verify_exness_provider():
    """Read-only verification from cached independent quote trackers; opens no broker sockets."""
    provider = os.getenv("MARKET_DATA_PROVIDER", "exness").strip().lower()
    if provider != "exness":
        return JSONResponse(status_code=409, content={
            "provider": provider, "verified": False,
            "message": "Set MARKET_DATA_PROVIDER=exness to run this verification."
        })
    from app.market_data_manager import SYMBOLS, get_tracked_quote
    from datetime import datetime, timezone

    symbols = ["XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "AUDUSD", "NZDUSD", "GBPJPY"]
    results = {}
    weekend = datetime.now(timezone.utc).weekday() >= 5
    for symbol in symbols:
        quote = get_tracked_quote(symbol)
        status = quote.get("status", "OFFLINE")
        detail = quote.get("detail")
        if weekend and symbol != "BTCUSD" and status != "LIVE":
            status = "MARKET_CLOSED"
            detail = "Forex/metal market is closed for the weekend; retry during market hours."
        results[symbol] = {
            "status": status,
            "provider": quote.get("provider") or "Exness Trader API",
            "provider_symbol": quote.get("provider_symbol"),
            "updated_at": quote.get("updated_at"),
            "price": quote.get("price"),
            "quote_age_seconds": quote.get("quote_age_seconds"),
            "error": detail,
        }
    live_count = sum(1 for result in results.values() if result["status"] == "LIVE")
    return {
        "provider": "Exness Trader API", "verified": live_count == len(symbols),
        "live_count": live_count, "instrument_count": len(symbols), "results": results,
        "note": "Read-only verification from cached quote trackers. This endpoint opens no WebSocket connections, helping avoid extra Exness/Cloudflare handshakes. MARKET_CLOSED is expected on weekends; tracker states reflect actual quote availability."
    }

@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "service": "goldsight-api", "timestamp": datetime.now(timezone.utc).isoformat(), "provider_mode": os.getenv("MARKET_DATA_PROVIDER", "exness"), "providers": {"XAUUSD": "configured signal provider; live status requires fresh candles", "XAUUSD_spot_reference": "XAUS indicative spot endpoint; separate from signal candles", "BTCUSD": "configured provider; live status requires a fresh quote", "EURUSD": "configured provider; live status requires fresh candles", "GBPUSD": "configured provider; live status requires fresh candles"}}

@app.get("/api/v1/spot/XAUUSD")
def gold_spot_reference():
    """Indicative spot reference only; intentionally not a signal/candle endpoint."""
    from app.spot_data import fetch_xaus_spot
    try:
        return fetch_xaus_spot()
    except MarketUnavailable as exc:
        return JSONResponse(
            status_code=503,
            content={
                "symbol": "XAUUSD",
                "provider": "XAUS indicative gold spot API",
                "status": "OFFLINE",
                "price": None,
                "bid": None,
                "ask": None,
                "spread": None,
                "tradable_quote": False,
                "candles_available": False,
                "detail": str(exc),
            },
        )

def fetch_timeframe_market(symbol: str, timeframe: str, limit: int = 240):
    """Fetch provider bars or aggregate aligned 45m candles from 15m bars."""
    if timeframe != "45m":
        return fetch_market(symbol, timeframe, limit=limit)
    base = fetch_market(symbol, "15m", limit=min(1000, limit * 3 + 3))
    candles = aggregate_15m_to_45m(base.get("candles", []), limit=limit)
    if len(candles) < 45:
        raise MarketUnavailable(
            f"Only {len(candles)} complete 45m candles could be built from 15m data; at least 45 are required."
        )
    base["candles"] = candles
    base["timeframe"] = "45m"
    base["provider_timeframe"] = "15m candles aggregated into aligned 45m candles"
    return base


@app.get("/api/v1/backtest/{symbol}/cost-sensitivity")
def backtest_cost_sensitivity(
    symbol: str,
    timeframe: str = Query("15m", pattern="^(5m|15m|45m|1h|4h)$"),
    target_r: float = Query(2.0, ge=1.0, le=3.0),
    max_hold_bars: int = Query(24, ge=1, le=100),
    candles_limit: int = Query(1000, ge=45, le=1000),
    commission_r: float = Query(0.0, ge=0.0),
    slippage_price: float = Query(0.0, ge=0.0),
):
    """Compare backtest outcomes under progressively harsher transaction costs."""
    normalized = symbol.upper()
    if normalized not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Unsupported market symbol.")
    try:
        data = fetch_timeframe_market(normalized, timeframe)
        higher_tf = {"5m": "15m", "15m": "1h", "45m": "1h", "1h": "4h"}.get(timeframe)
        higher_candles = fetch_market(normalized, higher_tf).get("candles", []) if higher_tf else None
        return run_cost_sensitivity(
            symbol=normalized,
            timeframe=timeframe,
            candles=data.get("candles", [])[-candles_limit:],
            spread=data.get("spread"),
            higher_candles=higher_candles,
            target_r=target_r,
            max_hold_bars=max_hold_bars,
            commission_r=commission_r,
            slippage_price=slippage_price,
        )
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Historical market data unavailable: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc




@app.get("/api/v1/backtest/{symbol}/regime-analysis")
def backtest_regime_analysis(
    symbol: str,
    timeframe: str = Query("15m", pattern="^(5m|15m|45m|1h|4h)$"),
    target_r: int = Query(2, ge=1, le=3),
    max_hold_bars: int = Query(24, ge=1, le=100),
    candles_limit: int = Query(1000, ge=45, le=1000),
    commission_r: float = Query(0.0, ge=0.0),
    slippage_price: float = Query(0.0, ge=0.0),
):
    """Compare historical backtest slices in trending, ranging and high-volatility regimes."""
    normalized = symbol.upper()
    if normalized not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Unsupported market symbol.")
    try:
        data = fetch_timeframe_market(normalized, timeframe, limit=candles_limit)
        higher_tf = {"5m": "15m", "15m": "1h", "45m": "1h", "1h": "4h"}.get(timeframe)
        higher_candles = fetch_market(normalized, higher_tf, limit=candles_limit).get("candles", []) if higher_tf else None
        return run_regime_analysis(
            candles=data.get("candles", [])[-candles_limit:], symbol=normalized,
            timeframe=timeframe, spread=data.get("spread"), higher_candles=higher_candles,
            target_r=target_r, max_hold_bars=max_hold_bars,
            commission_r=commission_r, slippage_price=slippage_price,
        )
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Historical market data unavailable: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/backtest/{symbol}")
def backtest(
    symbol: str,
    timeframe: str = Query("15m", pattern="^(5m|15m|45m|1h|4h)$"),
    target_r: int = Query(2, ge=1, le=3),
    max_hold_bars: int = Query(24, ge=1, le=100),
    candles_limit: int = Query(1000, ge=45, le=1000),
    commission_r: float = Query(0.0, ge=0.0, description="Estimated round-trip commission expressed in R."),
    slippage_price: float = Query(0.0, ge=0.0, description="Estimated adverse slippage per side in the instrument's price units."),
):
    """Run a walk-forward backtest; costs are configurable estimates, not broker historical fills."""
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Supported symbols: XAUUSD, BTCUSD, EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF and NZDUSD.")
    try:
        data = fetch_timeframe_market(symbol, timeframe, limit=candles_limit)
        higher_map = {"5m": "15m", "15m": "1h", "45m": "1h", "1h": "4h"}
        higher_tf = higher_map.get(timeframe)
        higher_candles = None
        if higher_tf:
            higher_data = fetch_market(symbol, higher_tf, limit=candles_limit)
            higher_candles = higher_data.get("candles", [])
        return run_backtest(
            data.get("candles", []), symbol, timeframe, data.get("spread"),
            higher_candles=higher_candles, target_r=target_r, max_hold_bars=max_hold_bars,
            commission_r=commission_r, slippage_price=slippage_price,
        )
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Backtest data unavailable: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/backtest/{symbol}/validation")
def backtest_validation(
    symbol: str,
    timeframe: str = Query("15m", pattern="^(5m|15m|45m|1h|4h)$"),
    target_r: int = Query(2, ge=1, le=3),
    max_hold_bars: int = Query(24, ge=1, le=100),
    candles_limit: int = Query(1000, ge=45, le=1000),
    commission_r: float = Query(0.0, ge=0.0, description="Estimated round-trip commission expressed in R."),
    slippage_price: float = Query(0.0, ge=0.0, description="Estimated adverse slippage per side in instrument price units."),
    train_fraction: float = Query(0.70, ge=0.50, le=0.85, description="Chronological in-sample fraction; remaining candles are held out."),
):
    """Evaluate a strategy on a chronological holdout segment without optimizing on OOS data."""
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Supported symbols: XAUUSD, BTCUSD, EURUSD and GBPUSD.")
    try:
        data = fetch_timeframe_market(symbol, timeframe, limit=candles_limit)
        higher_map = {"5m": "15m", "15m": "1h", "45m": "1h", "1h": "4h"}
        higher_tf = higher_map.get(timeframe)
        higher_candles = None
        if higher_tf:
            higher_data = fetch_market(symbol, higher_tf, limit=candles_limit)
            higher_candles = higher_data.get("candles", [])
        return run_walk_forward_validation(
            data.get("candles", []), symbol, timeframe, data.get("spread"),
            higher_candles=higher_candles, target_r=target_r,
            max_hold_bars=max_hold_bars, commission_r=commission_r,
            slippage_price=slippage_price, train_fraction=train_fraction,
        )
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Validation data unavailable: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/backtest/{symbol}/rolling-validation")
def rolling_backtest_validation(
    symbol: str,
    timeframe: str = Query("15m", pattern="^(5m|15m|45m|1h|4h)$"),
    target_r: int = Query(2, ge=1, le=3),
    max_hold_bars: int = Query(24, ge=1, le=100),
    candles_limit: int = Query(1000, ge=300, le=1000),
    folds: int = Query(3, ge=2, le=5),
    commission_r: float = Query(0.0, ge=0.0, description="Estimated round-trip commission expressed in R."),
    slippage_price: float = Query(0.0, ge=0.0, description="Estimated adverse slippage per side in instrument price units."),
    train_fraction: float = Query(0.60, ge=0.50, le=0.85, description="Initial chronological training fraction; later folds expand training."),
):
    """Evaluate sequential out-of-sample folds with an expanding training window."""
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Supported symbols: XAUUSD, BTCUSD, EURUSD and GBPUSD.")
    try:
        data = fetch_timeframe_market(symbol, timeframe, limit=candles_limit)
        higher_map = {"5m": "15m", "15m": "1h", "45m": "1h", "1h": "4h"}
        higher_tf = higher_map.get(timeframe)
        higher_candles = None
        if higher_tf:
            higher_data = fetch_market(symbol, higher_tf, limit=candles_limit)
            higher_candles = higher_data.get("candles", [])
        return run_rolling_walk_forward_folds(
            data.get("candles", []), symbol, timeframe, data.get("spread"),
            higher_candles=higher_candles, target_r=target_r,
            max_hold_bars=max_hold_bars, commission_r=commission_r,
            slippage_price=slippage_price, train_fraction=train_fraction,
            folds=folds,
        )
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Rolling validation data unavailable: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/v1/strategy-comparison/XAUUSD")
def compare_gold_strategies(
    history_months: int = Query(12, ge=3, le=24),
    target_r: int = Query(2, ge=1, le=3),
    max_hold_hours: int = Query(24, ge=4, le=168),
):
    """Compare 4H-only with 4H direction + 1H confirmation + 15M execution on one shared Exness history window."""
    if os.getenv("MARKET_DATA_PROVIDER", "exness").strip().lower() != "exness":
        raise HTTPException(status_code=400, detail="Strategy comparison currently requires MARKET_DATA_PROVIDER=exness.")
    end_ts = int(datetime.now(timezone.utc).timestamp())
    start_ts = int((datetime.now(timezone.utc) - timedelta(days=round(30.4375 * history_months))).timestamp())
    try:
        # Fetch every timeframe over the exact same UTC date window.
        candles_4h = exness_historical_candles("XAUUSD", "4h", start_ts, end_ts)
        candles_1h = exness_historical_candles("XAUUSD", "1h", start_ts, end_ts)
        candles_15m = exness_historical_candles("XAUUSD", "15m", start_ts, end_ts)
        if min(len(candles_4h), len(candles_1h), len(candles_15m)) < 45:
            raise MarketUnavailable("Insufficient shared historical candles. At least 45 candles per timeframe are required.")
        # Current spread is only a rough proxy; never present it as historical execution cost.
        current_spread = None
        spread_note = "No historical spread series is available; reported net R equals gross R and excludes spread, slippage, commission and financing."
        try:
            quote = fetch_market("XAUUSD", "15m", limit=45)
            current_spread = quote.get("spread")
            if current_spread is not None:
                spread_note = "Current observed spread is applied as a rough proxy to every historical trade; actual historical spreads, slippage, commission and financing are not modeled."
        except MarketUnavailable:
            pass
        hold_4h = max(1, round(max_hold_hours / 4))
        hold_15m = max(1, round(max_hold_hours * 4))
        baseline = run_backtest(
            candles_4h, "XAUUSD", "4h", current_spread,
            target_r=target_r, max_hold_bars=hold_4h,
        )
        hybrid = run_backtest(
            candles_15m, "XAUUSD", "15m", current_spread,
            higher_candles=candles_1h, trend_filter_candles=candles_4h,
            target_r=target_r, max_hold_bars=hold_15m,
        )
        baseline["strategy"] = "4H-only"
        baseline["execution_timeframe"] = "4h"
        baseline["max_hold_hours_approx"] = hold_4h * 4
        hybrid["strategy"] = "4H direction + 1H confirmation + 15M execution"
        hybrid["execution_timeframe"] = "15m"
        hybrid["max_hold_hours_approx"] = hold_15m / 4
        results = [baseline, hybrid]
        eligible = [
            x for x in results
            if x.get("trades", 0) >= 30
            and isinstance(x.get("net_r_total"), (int, float))
            and isinstance(x.get("profit_factor"), (int, float))
            and x["net_r_total"] > 0 and x["profit_factor"] > 1
        ]
        eligible.sort(key=lambda x: (x.get("average_net_r") or float("-inf"), x.get("profit_factor") or float("-inf")), reverse=True)
        return {
            "symbol": "XAUUSD",
            "comparison": "4H-only versus 4H bias + 1H confirmation + 15M execution",
            "comparison_mode": "same UTC history window",
            "history_months_requested": history_months,
            "sample_start": datetime.fromtimestamp(start_ts, timezone.utc).isoformat(),
            "sample_end": datetime.fromtimestamp(end_ts, timezone.utc).isoformat(),
            "target_r": target_r,
            "max_hold_hours_requested": max_hold_hours,
            "spread_cost_note": spread_note,
            "ranking_rule": "A provisional candidate requires at least 30 closed trades, positive net R and profit factor above 1. Rank by average net R, then profit factor. This is a research screen, not proof of an edge.",
            "provisional_candidate": eligible[0]["strategy"] if eligible else None,
            "winner_status": "PROVISIONAL_ONLY" if eligible else "NO_VALIDATED_WINNER",
            "warning": "Both strategies use walk-forward decisions and the same historical date window. The 4H-only strategy and hybrid have different execution frequencies; max holding periods are approximately time-matched. Results are not a substitute for out-of-sample validation.",
            "results": results,
        }
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Strategy comparison data unavailable: {exc}") from exc


@app.get("/api/v1/compare/{symbol}")
def compare_timeframes(
    symbol: str,
    target_r: int = Query(2, ge=1, le=3),
    max_hold_bars: int = Query(24, ge=1, le=100),
    candles_limit: int = Query(1000, ge=45, le=1000),
    comparison_mode: str = Query("available_history", pattern="^(available_history|common_window)$"),
    history_months: int = 0,
):
    """Compare timeframes; optionally fetch up to 12 months of paginated Exness history."""
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Supported markets: XAUUSD, BTCUSD, EURUSD and GBPUSD.")

    higher_map = {"5m": "15m", "15m": "1h", "45m": "1h", "1h": "4h"}
    timeframes = ["5m", "15m", "45m", "1h", "4h"]
    prepared = []
    history_end = int(datetime.now(timezone.utc).timestamp())
    history_start = int((datetime.now(timezone.utc) - timedelta(days=round(30.4375 * history_months))).timestamp()) if history_months else None
    historical_provider = os.getenv("MARKET_DATA_PROVIDER", "exness").strip().lower()
    historical_spread = None
    spread_cost_note = "Historical spread adjustment unavailable: Exness current quote could not be assumed for the entire six-month period. Net R equals gross R until spread is supplied; do not treat this as cost-adjusted performance."
    if history_months:
        if historical_provider != "exness":
            raise HTTPException(status_code=400, detail="Multi-month historical comparison currently requires MARKET_DATA_PROVIDER=exness.")
        # Do not block historical data retrieval on a live quote. Exness may rate-limit
        # the tick/candle endpoints separately; if a quote is unavailable, continue with
        # explicit zero spread-cost adjustment and disclose that limitation.
        try:
            live_quote = fetch_market(symbol, "5m", limit=45)
            historical_spread = live_quote.get("spread")
            if historical_spread is not None:
                spread_cost_note = "Current observed spread is applied as a rough proxy to historical trades; actual historical spreads, slippage and commission are not modeled."
        except MarketUnavailable:
            historical_spread = None

    def load_historical(tf: str):
        source_tf = "15m" if tf == "45m" else tf
        candles = exness_historical_candles(symbol, source_tf, history_start, history_end)
        if tf == "45m":
            candles = aggregate_15m_to_45m(candles, limit=100000)
        return candles

    for timeframe in timeframes:
        try:
            if history_months:
                candles = load_historical(timeframe)
                data = {"candles": candles, "spread": historical_spread, "provider": "Exness paginated historical candles"}
            else:
                data = fetch_timeframe_market(symbol, timeframe, limit=candles_limit)
                candles = data.get("candles", [])
            higher_tf = higher_map.get(timeframe)
            higher_candles = None
            if higher_tf:
                if history_months:
                    higher_candles = load_historical(higher_tf)
                else:
                    higher_data = fetch_market(symbol, higher_tf, limit=candles_limit)
                    higher_candles = higher_data.get("candles", [])
            times = [int(c["time"]) for c in candles if "time" in c]
            prepared.append({
                "timeframe": timeframe, "data": data, "candles": candles,
                "higher_candles": higher_candles, "error": None,
                "start": min(times) if times else None, "end": max(times) if times else None,
            })
        except MarketUnavailable as exc:
            prepared.append({
                "timeframe": timeframe, "data": {}, "candles": [],
                "higher_candles": None, "error": f"Data unavailable: {exc}",
                "start": None, "end": None,
            })

    common_start = common_end = None
    if comparison_mode == "common_window":
        available = [x for x in prepared if x["start"] is not None and x["end"] is not None]
        if len(available) >= 2:
            common_start = max(x["start"] for x in available)
            common_end = min(x["end"] for x in available)
            if common_start > common_end:
                common_start = common_end = None

    results = []
    for item in prepared:
        timeframe = item["timeframe"]
        if item["error"]:
            results.append({
                "symbol": symbol, "timeframe": timeframe, "trades": 0,
                "win_rate_pct": None, "net_r_total": None, "average_net_r": None,
                "profit_factor": None, "max_drawdown_r": None, "error": item["error"],
            })
            continue
        candles = item["candles"]
        higher_candles = item["higher_candles"]
        if comparison_mode == "common_window":
            if common_start is None or common_end is None:
                # Never silently fall back to incomparable full-history samples.
                candles = []
                higher_candles = []
            else:
                candles = [c for c in candles if common_start <= int(c.get("time", 0)) <= common_end]
                # Keep earlier higher-timeframe candles for indicator warm-up, but never
                # allow higher-timeframe bars after the shared comparison end.
                if higher_candles is not None:
                    higher_candles = [c for c in higher_candles if int(c.get("time", 0)) <= common_end]
        result = run_backtest(
            candles, symbol, timeframe, item["data"].get("spread"),
            higher_candles=higher_candles, target_r=target_r, max_hold_bars=max_hold_bars,
        )
        results.append(result)

    # Do not crown a winner from a tiny sample or a non-positive result.
    eligible = [
        item for item in results
        if item.get("trades", 0) >= 20
        and isinstance(item.get("net_r_total"), (int, float))
        and isinstance(item.get("profit_factor"), (int, float))
        and item["net_r_total"] > 0
        and item["profit_factor"] > 1
    ]
    eligible.sort(
        key=lambda item: (
            item.get("average_net_r") if isinstance(item.get("average_net_r"), (int, float)) else float("-inf"),
            item.get("profit_factor") if isinstance(item.get("profit_factor"), (int, float)) else float("-inf"),
            item.get("win_rate_pct") if isinstance(item.get("win_rate_pct"), (int, float)) else float("-inf"),
        ),
        reverse=True,
    )
    common_window = None
    if comparison_mode == "common_window":
        common_window = {
            "start": datetime.fromtimestamp(common_start, timezone.utc).isoformat() if common_start is not None else None,
            "end": datetime.fromtimestamp(common_end, timezone.utc).isoformat() if common_end is not None else None,
            "span_days": round((common_end - common_start) / 86400, 2) if common_start is not None and common_end is not None else 0,
            "note": "All primary timeframe candles are restricted to this overlap. Higher-timeframe candles before the start are retained only for indicator warm-up; bars after the end are excluded. Short overlaps may leave slower timeframes with too few bars to test.",
        }
    return {
        "symbol": symbol,
        "comparison_mode": comparison_mode,
        "requested_history_months": history_months,
        "spread_cost_note": spread_cost_note if history_months else "Available-history mode uses provider-reported current spread as a rough historical proxy; slippage and commission are not modeled.",
        "common_window": common_window,
        "method": "Shared-date comparisons restrict all primary timeframe candles to the common overlap; available-history mode uses each provider's full available sample. Results remain provisional.",
        "ranking_rule": "A provisional candidate must have at least 20 trades, positive net R, and profit factor above 1. Candidates are ordered by average net R, then profit factor, then win rate.",
        "provisional_best_timeframe": eligible[0]["timeframe"] if eligible else None,
        "winner_status": "PROVISIONAL_ONLY" if eligible else "NO_VALIDATED_WINNER",
        "warning": "The highest win rate alone is not enough. Provider history may be short, costs omit slippage and commission, and shared-window tests may be too short for higher timeframes. Validate finalists on longer historical data before using real money.",
        "results": results,
    }



@app.get("/api/v1/quotes/{symbol}")
def independent_live_quote(symbol: str):
    """Independent tick-only feed for the Live Market Watch dashboard."""
    normalized = symbol.upper()
    if normalized not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Unsupported symbol.")
    # Read from this symbol's isolated background tracker. A provider failure
    # for one symbol does not stop or overwrite the other symbol trackers.
    quote = get_tracked_quote(normalized)
    if quote.get("status") == "OFFLINE":
        return JSONResponse(status_code=503, content=quote)
    return quote


@app.get("/api/v1/market/{symbol}/batch")
def market_batch(symbol: str):
    """Fetch the four supported signal timeframes once and return all analyses together."""
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Supported symbols: XAUUSD, BTCUSD, EURUSD and GBPUSD.")

    # Respect the symbol-wide setup cooldown without blocking market data.
    # The variable must be defined before the signal loop uses it.
    scan_setups = True
    if database_configured():
        try:
            scan_setups = not is_symbol_in_setup_cooldown(symbol, 10)
        except Exception:
            import logging
            logging.getLogger(__name__).exception(
                "Could not verify setup cooldown for %s; preserving batch market endpoint availability.",
                symbol,
            )

    timeframes = ("5m", "15m", "1h", "4h")
    fetched = {}
    errors = {}
    fetch_timings_ms = {}
    batch_fetch_started = perf_counter()
    batch_route_started = batch_fetch_started
    analysis_timings_ms = {}

    # One provider fetch per timeframe. The old per-timeframe route fetched the
    # same higher-timeframe candles repeatedly for each of the four requests.
    with ThreadPoolExecutor(max_workers=4) as executor:
        pending = {}
        fetch_started = {}
        for tf in timeframes:
            fetch_started[tf] = perf_counter()
            pending[executor.submit(fetch_market, symbol, tf)] = tf
        for future in as_completed(pending):
            tf = pending[future]
            try:
                fetched[tf] = future.result()
            except MarketUnavailable as exc:
                errors[tf] = str(exc)
            finally:
                fetch_timings_ms[tf] = round((perf_counter() - fetch_started[tf]) * 1000, 1)

    session = xauusd_market_status() if symbol == "XAUUSD" else None
    session_closed = bool(session and session["market_status"] == "MARKET_CLOSED")

    trends = {
        tf: calculate_trend(data.get("candles", []), tf)
        for tf, data in fetched.items()
    }
    results = {}

    for timeframe in timeframes:
        analysis_started = perf_counter()
        if timeframe not in fetched:
            reason = errors.get(timeframe, "Market data unavailable.")
            market_closed = session_closed and symbol == "XAUUSD"
            results[timeframe] = {
                "symbol": symbol, "timeframe": timeframe,
                "status": "MARKET_CLOSED" if market_closed else "OFFLINE",
                "market_status": session["market_status"] if market_closed else "OFFLINE",
                "market_phase": session["market_phase"] if market_closed else None,
                "next_open_at": session["next_open_at"] if market_closed else None,
                "schedule_timezone": session["schedule_timezone"] if market_closed else None,
                "provider": "none", "price": None, "bid": None, "ask": None,
                "spread": None, "updated_at": None, "candles": [],
                "candle_status": "MARKET_CLOSED" if market_closed else "OFFLINE",
                "signal": {
                    "status": "NO SETUP", "side": "NO SETUP", "entry": None,
                    "stop_loss": None, "take_profits": [], "rr": None,
                    "confidence": None,
                    "reasons": ["Exness XAUUSD market is closed; fresh signals are paused."] if market_closed else [reason],
                    "invalidation": "No setup is available while the market is closed." if market_closed else "No setup is available while live data is offline.",
                    "signal_time": None, "trend": "UNKNOWN",
                    "signal_fresh": False, "signal_age_seconds": None,
                },
            }
            analysis_timings_ms[timeframe] = round((perf_counter() - analysis_started) * 1000, 1)
            continue

        data = dict(fetched[timeframe])
        data["timeframe"] = timeframe
        data["candles"] = normalize_candles(data.get("candles", []))
        higher_tf = {"5m": "15m", "15m": "1h", "1h": "4h"}.get(timeframe)
        higher_candles = fetched.get(higher_tf, {}).get("candles", []) if higher_tf else None
        if higher_tf:
            data["higher_timeframe"] = higher_tf
            data["higher_timeframe_status"] = fetched.get(higher_tf, {}).get("status", "UNAVAILABLE")

        signal_candles = completed_candles(data["candles"], timeframe)
        signal_higher_candles = completed_candles(higher_candles, higher_tf) if higher_tf and higher_candles else higher_candles
        if scan_setups:
            signal = analyze(
                signal_candles, symbol, timeframe, data.get("spread"),
                signal_higher_candles, include_last_completed=True,
            )
        else:
            signal = no_setup("Setup scan paused: symbol-wide 10-minute cooldown is active.")
            signal["signal_fresh"] = False
            signal["signal_age_seconds"] = None
            signal["last_completed_candle_time"] = None
        if higher_tf and higher_tf not in fetched:
            signal = no_setup(f"Higher-timeframe data unavailable ({higher_tf}); refusing to issue a trade signal.")
            signal["higher_timeframe_trend"] = "UNKNOWN"
        signal = _require_live_spread(signal, data)

        seconds = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}[timeframe]
        if signal_candles:
            completed_bar = signal_candles[-1]
            candle_time = int(completed_bar.get("time", 0))
            age = int(datetime.now(timezone.utc).timestamp() - (candle_time + seconds))
            signal["last_completed_candle_time"] = datetime.fromtimestamp(candle_time, timezone.utc).isoformat()
            signal["signal_age_seconds"] = max(0, age)
            freshness_grace = _signal_freshness_grace_seconds(timeframe)
            signal["signal_fresh"] = -30 <= age <= freshness_grace
            if age > freshness_grace:
                signal = no_setup("Latest completed candle is stale; waiting for fresh candle data.")
                signal["last_completed_candle_time"] = datetime.fromtimestamp(candle_time, timezone.utc).isoformat()
                signal["signal_age_seconds"] = age
                signal["signal_fresh"] = False
                if higher_tf:
                    signal["higher_timeframe"] = higher_tf
                    signal["higher_timeframe_trend"] = trends.get(higher_tf, "UNKNOWN")
        else:
            signal = no_setup("Not enough candles to verify signal freshness.")
            signal["signal_fresh"] = False
            signal["signal_age_seconds"] = None
            signal["last_completed_candle_time"] = None

        candle_feed_fresh = False
        if signal_candles:
            latest_candle = signal_candles[-1]
            candle_seconds = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}[timeframe]
            candle_age = datetime.now(timezone.utc).timestamp() - (
                int(latest_candle["time"]) + candle_seconds
            )
            candle_feed_fresh = (
                -30 <= candle_age <= _signal_freshness_grace_seconds(timeframe)
            )

        if signal.get("status") in {"BUY", "SELL"}:
            expected = "BULLISH" if signal["status"] == "BUY" else "BEARISH"
            alignment = [
                {"timeframe": upper_tf, "trend": trends.get(upper_tf, "UNKNOWN")}
                for upper_tf in timeframes if timeframes.index(upper_tf) > timeframes.index(timeframe)
            ]
            mismatch = next((item for item in alignment if item["trend"] != expected), None)
            signal["higher_timeframe_alignment"] = alignment
            if mismatch:
                signal = no_setup(
                    f"Setup rejected: {mismatch['timeframe']} trend is {mismatch['trend']}; "
                    f"{expected} alignment is required across all higher timeframes."
                )
                signal["trend"] = expected
                signal["higher_timeframe_alignment"] = alignment
            else:
                signal.update(classify_trade_context(symbol, signal))
        else:
            signal["trade_type"] = "NO TRADE"
            signal["news_context"] = None
            signal["news_context_status"] = "NO_ACTIVE_SETUP"

        data["signal"] = signal
        try:
            process_demo_market(symbol, timeframe, data, allow_new_entries=scan_setups)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Demo trade processing failed for %s %s", symbol, timeframe)
        # The provider quote can be live while its historical candles are stale.
        # Keep the quote state visible, but make the timeframe status describe OHLC data.
        data["quote_status"] = data.get("status")
        data["candle_status"] = "LIVE" if candle_feed_fresh else "STALE"
        data["status"] = data["candle_status"]
        results[timeframe] = data
        analysis_timings_ms[timeframe] = round((perf_counter() - analysis_started) * 1000, 1)

    # Trend candles and Live Market Watch ticks are distinct provider reads.
    # A batch is LIVE only when every required timeframe has fresh completed candles.
    quote_snapshot = get_tracked_quote(symbol)
    candle_states = [results[tf].get("candle_status", "OFFLINE") for tf in timeframes]
    candle_status = _batch_candle_feed_status(candle_states, session_closed=session_closed)
    return {
        "symbol": symbol,
        "status": candle_status,
        "candle_feed_status": candle_status,
        "quote_status": quote_snapshot.get("status", "OFFLINE"),
        "live_market_watch_quote": quote_snapshot,
        "feed_relationship": "Trend uses provider candles; Live Market Watch uses an independent tick tracker. Statuses may differ during provider outages or candle delays.",
        "market_status": session["market_status"] if session else None,
        "market_phase": session["market_phase"] if session else None,
        "next_open_at": session["next_open_at"] if session else None,
        "schedule_timezone": session["schedule_timezone"] if session else None,
        "timeframes": results,
        "provider_fetches": len(fetched),
        "provider_fetch_timings_ms": fetch_timings_ms,
        "provider_batch_fetch_elapsed_ms": round((perf_counter() - batch_fetch_started) * 1000, 1),
        "timeframe_analysis_timings_ms": analysis_timings_ms,
        "market_batch_total_elapsed_ms": round((perf_counter() - batch_route_started) * 1000, 1),
        "provider_errors": errors,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/v1/market/{symbol}/history")
def market_history(
    symbol: str,
    timeframe: str = Query("15m", pattern="^(5m|15m|30m|1h|4h)$"),
    start: int = Query(..., ge=0),
    end: int | None = Query(None, ge=0),
):
    """Return verified provider candles from a saved setup timestamp to now."""
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Unsupported market symbol.")
    now_ts = int(datetime.now(timezone.utc).timestamp())
    seconds = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}[timeframe]
    # outcome_at stores the candle open time; include the full outcome candle.
    end_ts = min((end + seconds) if end is not None else now_ts, now_ts)
    if start >= end_ts:
        raise HTTPException(status_code=400, detail="History start must be before the current market time.")
    max_bars = 5000
    fetch_start = max(start - seconds * 3, end_ts - seconds * max_bars, 0)
    try:
        candles = exness_historical_candles(symbol, timeframe, fetch_start, end_ts)
    except MarketUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Verified historical candles unavailable: {exc}") from exc
    if not candles:
        raise HTTPException(status_code=503, detail="Provider returned no historical candles for this setup window.")
    return {
        "symbol": symbol, "timeframe": timeframe, "provider": "Exness Trader API",
        "status": "LIVE", "candles": candles, "count": len(candles),
        "signal_time": start, "history_truncated": fetch_start > max(0, start - seconds * 3),
        "from": candles[0]["time"], "to": candles[-1]["time"],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/v1/market/{symbol}")
def market(symbol: str, timeframe: str = Query("15m", pattern="^(5m|15m|30m|1h|4h)$"), scan_setups: bool = True):
    symbol = symbol.upper()
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDNGN"}:
        raise HTTPException(status_code=404, detail="Supported symbols: XAUUSD, BTCUSD, EURUSD and GBPUSD.")
    if scan_setups and database_configured():
        try:
            scan_setups = not is_symbol_in_setup_cooldown(symbol, 10)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Could not verify setup cooldown for %s; preserving market endpoint availability.", symbol)
    try:
        data = fetch_timeframe_market(symbol, timeframe)
        data["timeframe"] = timeframe

        # Require an aligned higher-timeframe trend for 5m, 15m, and 1h signals.
        higher_map = {"5m": "15m", "15m": "1h", "30m": "1h", "1h": "4h"}
        higher_tf = higher_map.get(timeframe)
        higher_candles = None
        higher_error = None
        if higher_tf:
            try:
                higher_data = fetch_market(symbol, higher_tf)
                higher_candles = higher_data.get("candles", [])
                data["higher_timeframe"] = higher_tf
                data["higher_timeframe_status"] = higher_data.get("status", "UNKNOWN")
            except MarketUnavailable as exc:
                higher_error = str(exc)
                data["higher_timeframe"] = higher_tf
                data["higher_timeframe_status"] = "UNAVAILABLE"

        # Normalize provider ordering before charting or signal calculations.
        data["candles"] = normalize_candles(data.get("candles", []))
        if higher_candles is not None:
            higher_candles = normalize_candles(higher_candles)

        # Only bars whose full timeframe has elapsed can contribute to a live signal.
        signal_candles = completed_candles(data["candles"], timeframe)
        signal_higher_candles = (
            completed_candles(higher_candles, higher_tf)
            if higher_tf and higher_candles is not None else higher_candles
        )
        if scan_setups:
            signal = analyze(
                signal_candles, symbol, timeframe, data.get("spread"),
                signal_higher_candles, include_last_completed=True,
            )
        else:
            signal = no_setup("Setup scan paused: symbol-wide 10-minute cooldown is active.")
            signal["signal_fresh"] = False
            signal["signal_age_seconds"] = None
            signal["last_completed_candle_time"] = None
        if higher_error and timeframe != "4h":
            signal = no_setup(f"Higher-timeframe data unavailable ({higher_tf}); refusing to issue a trade signal.")
            signal["higher_timeframe_trend"] = "UNKNOWN"
        signal = _require_live_spread(signal, data)

        # A signal must be based on a recently completed candle, not just a fresh quote.
        candles = data.get("candles", [])
        seconds = {"5m": 300, "15m": 900, "30m": 1800, "45m": 2700, "1h": 3600, "4h": 14400}[timeframe]
        if signal_candles:
            completed = signal_candles[-1]
            candle_time = int(completed.get("time", 0))
            age = int(datetime.now(timezone.utc).timestamp() - (candle_time + seconds))
            signal["last_completed_candle_time"] = datetime.fromtimestamp(candle_time, timezone.utc).isoformat()
            signal["signal_age_seconds"] = max(0, age)
            freshness_grace = _signal_freshness_grace_seconds(timeframe)
            signal["signal_fresh"] = -30 <= age <= freshness_grace
            if age > freshness_grace:
                signal = no_setup("Latest completed candle is stale; waiting for fresh candle data.")
                signal["last_completed_candle_time"] = datetime.fromtimestamp(candle_time, timezone.utc).isoformat()
                signal["signal_age_seconds"] = age
                signal["signal_fresh"] = False
                if higher_tf:
                    signal["higher_timeframe"] = higher_tf
                    signal["higher_timeframe_trend"] = "UNKNOWN" if higher_error else "CHECKED"
        else:
            signal = no_setup("Not enough candles to verify signal freshness.")
            signal["signal_fresh"] = False
            signal["signal_age_seconds"] = None
            signal["last_completed_candle_time"] = None
        if signal.get("status") in {"BUY", "SELL"}:
            # Enforce the same all-higher-timeframe alignment in the API itself.
            # The background recorder calls this exact endpoint, so alerts and Forecast
            # cannot disagree because of a frontend-only filter.
            rank = {"5m": 0, "15m": 1, "1h": 2, "4h": 3}
            expected = "BULLISH" if signal["status"] == "BUY" else "BEARISH"
            alignment = []
            alignment_error = None
            for upper_tf in ("5m", "15m", "1h", "4h"):
                if rank[upper_tf] <= rank[timeframe]:
                    continue
                try:
                    upper_data = fetch_market(symbol, upper_tf)
                    upper_trend = calculate_trend(upper_data.get("candles", []), upper_tf)
                except MarketUnavailable:
                    upper_trend = "UNKNOWN"
                alignment.append({"timeframe": upper_tf, "trend": upper_trend})
                if upper_trend != expected:
                    alignment_error = f"Setup rejected: {upper_tf} trend is {upper_trend}; {expected} alignment is required across all higher timeframes."
                    break
            signal["higher_timeframe_alignment"] = alignment
            if alignment_error:
                signal = no_setup(alignment_error)
                signal["trend"] = expected
                signal["higher_timeframe_alignment"] = alignment
            else:
                signal.update(classify_trade_context(symbol, signal))
        else:
            signal["trade_type"] = "NO TRADE"
            signal["news_context"] = None
            signal["news_context_status"] = "NO_ACTIVE_SETUP"
        data["signal"] = signal
        # Feed every live, completed-candle market evaluation into the paper
        # engine. Failures are logged but must never take down market data.
        try:
            process_demo_market(symbol, timeframe, data)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Demo trade processing failed for %s %s", symbol, timeframe)
        return data
    except MarketUnavailable as exc:
        session = xauusd_market_status() if symbol == "XAUUSD" else None
        market_closed = bool(session and session["market_status"] == "MARKET_CLOSED")
        payload = {
            "symbol": symbol, "timeframe": timeframe,
            "status": "MARKET_CLOSED" if market_closed else "OFFLINE",
            "market_status": session["market_status"] if market_closed else "OFFLINE",
            "market_phase": session["market_phase"] if market_closed else None,
            "next_open_at": session["next_open_at"] if market_closed else None,
            "schedule_timezone": session["schedule_timezone"] if market_closed else None,
            "provider": "none", "price": None, "bid": None, "ask": None,
            "spread": None, "updated_at": None, "candles": [],
            "signal": {
                "status": "NO SETUP", "side": "NO SETUP", "entry": None,
                "stop_loss": None, "take_profits": [], "rr": None,
                "confidence": None,
                "reasons": ["Exness XAUUSD market is closed; fresh signals are paused."] if market_closed else [str(exc)],
                "invalidation": "No setup is available while the market is closed." if market_closed else "No setup is available while live data is offline.",
                "signal_time": None, "trend": "UNKNOWN", "signal_fresh": False,
            },
        }
        return JSONResponse(status_code=503, content=payload)

