"""Exness Trader API read-only market-data adapter.

Uses signed REST requests for account discovery/candle history and a signed
WebSocket handshake for fresh ticks. This module never places orders.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from threading import Lock
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

try:
    import websocket
except ImportError:  # pragma: no cover - surfaced as a controlled offline state
    websocket = None

from app.market import MarketUnavailable

TIMEFRAMES = {
    "5m": ("M5", 300),
    "15m": ("M15", 900),
    "30m": ("M30", 1800),
    "1h": ("H1", 3600),
    "4h": ("H4", 14400),
}
_LOCK = Lock()
_ACCESS_POINT: str | None = None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _private_key() -> Ed25519PrivateKey:
    raw = os.getenv("EXN_PRIVATE_KEY", "").strip()
    if not raw:
        raise MarketUnavailable("Exness API is not configured: EXN_PRIVATE_KEY is missing.")
    # Preferred format documented by Exness is a PEM-encoded Ed25519 private key.
    try:
        key = serialization.load_pem_private_key(raw.replace("\\n", "\n").encode(), password=None)
    except (ValueError, TypeError):
        key = None
    if isinstance(key, Ed25519PrivateKey):
        return key
    # Exness-generated secrets may be provided as a 64-character hexadecimal
    # encoding of the 32-byte Ed25519 seed. Decode this before trying Base64URL,
    # because hexadecimal strings are also valid Base64URL characters.
    if len(raw) == 64 and all(ch in "0123456789abcdefABCDEF" for ch in raw):
        try:
            return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(raw))
        except ValueError:
            pass
    # Some Ed25519 libraries serialize a secret as 64 bytes: 32-byte seed
    # followed by the matching 32-byte public key. Accept this only when the
    # public half matches the public key derived from the seed.
    if len(raw) == 128 and all(ch in "0123456789abcdefABCDEF" for ch in raw):
        try:
            secret = bytes.fromhex(raw)
            candidate = Ed25519PrivateKey.from_private_bytes(secret[:32])
            derived_public = candidate.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
            if derived_public == secret[32:]:
                return candidate
        except ValueError:
            pass
    # Also accept a base64url-encoded 32-byte Ed25519 seed.
    try:
        seed = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
        if len(seed) == 32:
            return Ed25519PrivateKey.from_private_bytes(seed)
    except Exception:
        pass
    # Diagnostic details deliberately exclude the secret itself. This helps detect
    # Render values with extra quotes, prefixes, whitespace, or unexpected length.
    is_hex64 = len(raw) == 64 and all(ch in "0123456789abcdefABCDEF" for ch in raw)
    is_hex128 = len(raw) == 128 and all(ch in "0123456789abcdefABCDEF" for ch in raw)
    has_outer_quotes = len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ("'", '"')
    has_0x_prefix = raw.lower().startswith("0x")
    has_whitespace = any(ch.isspace() for ch in raw)
    raise MarketUnavailable(
        "EXN_PRIVATE_KEY format rejected (secret not shown): "
        f"length={len(raw)}, hex64={is_hex64}, hex128={is_hex128}, outer_quotes={has_outer_quotes}, "
        f"0x_prefix={has_0x_prefix}, whitespace={has_whitespace}. "
        "Expected PEM, a 64-character hexadecimal seed, a validated 128-character seed+public-key hex pair, or a base64url 32-byte seed."
    )


def _signed_headers(method: str, path: str, body: bytes = b"") -> dict[str, str]:
    api_key = os.getenv("EXN_API_KEY", "").strip()
    if not api_key:
        raise MarketUnavailable("Exness API is not configured: EXN_API_KEY is missing.")
    timestamp = int(time.time() * 1000)
    idempotency_key = ""
    payload = {
        "api_key": api_key,
        "idempotency_key": idempotency_key,
        "timestamp": timestamp,
        "sign_version": 1,
        "method": method.upper(),
        "path": path,
        "body_hash": _b64url(hashlib.sha256(body).digest()),
    }
    payload_bytes = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    signature = _private_key().sign(payload_bytes)
    return {
        "Accept": "application/json",
        "EXN-API-KEY": api_key,
        "EXN-IDEMPOTENCY-KEY": idempotency_key,
        "EXN-TIMESTAMP": str(timestamp),
        "EXN-SIGN-VERSION": "1",
        "EXN-DATA": _b64url(payload_bytes),
        "EXN-SIGN": _b64url(signature),
        "User-Agent": "GoldSightAI/1.0",
    }


def _json_request(base_url: str, path: str) -> dict[str, Any]:
    headers = _signed_headers("GET", path)
    request = Request(base_url.rstrip("/") + path, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            details = exc.read().decode("utf-8")[:500]
        except Exception:
            details = str(exc)
        raise MarketUnavailable(f"Exness REST request failed (HTTP {exc.code}): {details}") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        raise MarketUnavailable(f"Exness REST request failed: {exc}") from exc
    if not isinstance(data, dict):
        raise MarketUnavailable("Exness returned an unexpected response format.")
    return data


def _access_point() -> str:
    global _ACCESS_POINT
    if _ACCESS_POINT:
        return _ACCESS_POINT
    with _LOCK:
        if _ACCESS_POINT:
            return _ACCESS_POINT
        account_id = os.getenv("EXN_ACCOUNT_ID", "").strip()
        gateway = os.getenv("EXN_DISCOVERY_BASE_URL", "https://api.exness.com").strip()
        if not account_id or not account_id.isdigit():
            raise MarketUnavailable("Exness API is not configured: EXN_ACCOUNT_ID is missing or invalid.")
        path = "/v1/trading/access-point?" + urlencode({"account_id": account_id})
        data = _json_request(gateway, path)
        host = data.get("access_point")
        if not isinstance(host, str) or not host.strip():
            raise MarketUnavailable("Exness host discovery did not return an access_point.")
        if not host.startswith(("https://", "http://")):
            host = "https://" + host
        _ACCESS_POINT = host.rstrip("/")
        return _ACCESS_POINT


def _tick(symbol: str, timeout: float = 6.0) -> dict[str, Any]:
    if websocket is None:
        raise MarketUnavailable("websocket-client is not installed; cannot obtain Exness live ticks.")
    account_id = os.getenv("EXN_ACCOUNT_ID", "").strip()
    instrument = os.getenv("EXN_INSTRUMENT_" + symbol, symbol).strip()
    path = f"/v1/server-events/accounts/{account_id}/ws/ticks"
    base = _access_point()
    ws_url = base.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + path
    headers = _signed_headers("GET", path)
    try:
        conn = websocket.create_connection(
            ws_url, header=[f"{k}: {v}" for k, v in headers.items()],
            timeout=timeout, subprotocols=["exness-ws-protocol"],
            enable_multithread=False,
        )
        try:
            conn.send(json.dumps({
                "id": "goldsight-live-tick",
                "subscribe": {"event": "ticks", "instruments": [instrument]},
            }, separators=(",", ":")))
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                message = json.loads(conn.recv())
                if not isinstance(message, dict):
                    continue
                if message.get("instrument") != instrument:
                    continue
                bid, ask = float(message.get("bid", 0)), float(message.get("ask", 0))
                stamp = message.get("timestamp")
                if bid <= 0 or ask <= 0 or ask < bid or not stamp:
                    continue
                parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
                age = datetime.now(timezone.utc).timestamp() - parsed.timestamp()
                if age > 180 or age < -30:
                    continue
                return {"instrument": instrument, "bid": bid, "ask": ask, "timestamp": str(stamp)}
        finally:
            conn.close()
    except MarketUnavailable:
        raise
    except Exception as exc:
        raise MarketUnavailable(f"Exness live tick stream failed for {instrument}: {exc}") from exc
    raise MarketUnavailable(f"No fresh Exness tick received for {instrument} within {timeout:g} seconds.")


def exness_market(symbol: str, timeframe: str, limit: int = 240) -> dict[str, Any]:
    if timeframe not in TIMEFRAMES:
        raise MarketUnavailable("Exness timeframe must be 5m, 15m, 30m, 1h, or 4h.")
    account_id = os.getenv("EXN_ACCOUNT_ID", "").strip()
    instrument = os.getenv("EXN_INSTRUMENT_" + symbol, symbol).strip()
    ap = _access_point()
    # Confirm this symbol is enabled for the API key's trading account.
    instrument_path = f"/v1/configuration/accounts/{account_id}/instruments"
    instruments_response = _json_request(ap, instrument_path)
    available = instruments_response.get("instruments", [])
    names = [x if isinstance(x, str) else x.get("name", x.get("instrument", "")) for x in available]
    if instrument not in names:
        raise MarketUnavailable(f"{instrument} is not listed as available to this Exness API account.")

    exn_tf, seconds = TIMEFRAMES[timeframe]
    start = datetime.fromtimestamp(time.time() - seconds * (limit + 2), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    query = urlencode([
        ("instrument", instrument), ("price_type", "both"), ("timeframe", exn_tf),
        ("from", start), ("count", str(limit)),
    ])
    candles_path = f"/v1/market-data/accounts/{account_id}/candles?{query}"
    response = _json_request(ap, candles_path)
    raw_candles = response.get("candles")
    if not isinstance(raw_candles, list) or len(raw_candles) < 40:
        raise MarketUnavailable(f"Exness returned insufficient {timeframe} candles for {instrument}.")
    candles: list[dict[str, Any]] = []
    for item in raw_candles:
        if not isinstance(item, dict):
            continue
        bid = item.get("bid", item)
        try:
            dt = datetime.fromisoformat(str(item["time"]).replace("Z", "+00:00"))
            candles.append({
                "time": int(dt.timestamp()),
                "open": float(bid["open"]), "high": float(bid["high"]),
                "low": float(bid["low"]), "close": float(bid["close"]),
                "volume": int(float(item.get("volume", 0))),
            })
        except (KeyError, TypeError, ValueError):
            continue
    if len(candles) < 40:
        raise MarketUnavailable("Exness candle response did not contain enough valid OHLC data.")
    tick = _tick(symbol)
    bid, ask = tick["bid"], tick["ask"]
    return {
        "symbol": symbol, "provider_symbol": instrument, "provider": "Exness Trader API",
        "status": "LIVE", "price": (bid + ask) / 2, "bid": bid, "ask": ask,
        "spread": ask - bid, "digits": 3 if symbol == "XAUUSD" else 2,
        "updated_at": tick["timestamp"], "candles": candles,
    }



def exness_historical_candles(
    symbol: str,
    timeframe: str,
    start_ts: int,
    end_ts: int,
    page_size: int = 1000,
) -> list[dict[str, Any]]:
    """Fetch historical candles in bounded pages without requiring a live tick."""
    if timeframe not in TIMEFRAMES:
        raise MarketUnavailable("Unsupported Exness historical timeframe.")
    if start_ts >= end_ts:
        raise MarketUnavailable("Historical start must be before end.")
    if page_size < 50 or page_size > 1000:
        raise MarketUnavailable("Historical page size must be between 50 and 1000.")

    account_id = os.getenv("EXN_ACCOUNT_ID", "").strip()
    instrument = os.getenv("EXN_INSTRUMENT_" + symbol, symbol).strip()
    ap = _access_point()
    instrument_path = f"/v1/configuration/accounts/{account_id}/instruments"
    instruments_response = _json_request(ap, instrument_path)
    available = instruments_response.get("instruments", [])
    names = [x if isinstance(x, str) else x.get("name", x.get("instrument", "")) for x in available]
    if instrument not in names:
        raise MarketUnavailable(f"{instrument} is not listed as available to this Exness API account.")

    exn_tf, seconds = TIMEFRAMES[timeframe]
    candles_by_time: dict[int, dict[str, Any]] = {}
    cursor = start_ts
    # Bound the number of pages to prevent runaway requests if the provider repeats data.
    max_pages = 100
    pages = 0
    while cursor < end_ts and pages < max_pages:
        start = datetime.fromtimestamp(cursor, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        query = urlencode([
            ("instrument", instrument), ("price_type", "both"), ("timeframe", exn_tf),
            ("from", start), ("count", str(page_size)),
        ])
        path = f"/v1/market-data/accounts/{account_id}/candles?{query}"
        response = _json_request(ap, path)
        rows = response.get("candles")
        if not isinstance(rows, list) or not rows:
            break
        page_times: list[int] = []
        for item in rows:
            if not isinstance(item, dict):
                continue
            try:
                dt = datetime.fromisoformat(str(item["time"]).replace("Z", "+00:00"))
                stamp = int(dt.timestamp())
                if stamp < start_ts or stamp > end_ts:
                    continue
                bid = item.get("bid", item)
                bar = {
                    "time": stamp,
                    "open": float(bid["open"]), "high": float(bid["high"]),
                    "low": float(bid["low"]), "close": float(bid["close"]),
                    "volume": int(float(item.get("volume", 0))),
                }
                candles_by_time[stamp] = bar
                page_times.append(stamp)
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
        if not page_times:
            break
        newest = max(page_times)
        pages += 1
        if newest < cursor or newest >= end_ts:
            break
        # Advance beyond the latest returned candle to avoid repeated-page loops.
        next_cursor = newest + seconds
        if next_cursor <= cursor:
            break
        cursor = next_cursor
    if pages >= max_pages and cursor < end_ts:
        raise MarketUnavailable("Historical candle request exceeded 100 pages; narrow the requested date range.")
    return [candles_by_time[t] for t in sorted(candles_by_time)]
