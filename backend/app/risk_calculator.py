"""Broker-configurable position sizing for CFDs. Calculation only; never places orders."""
from __future__ import annotations
from math import floor
from typing import Any


def calculate_position_size(
    *,
    symbol: str,
    side: str,
    balance: float,
    risk_pct: float,
    entry: float,
    stop_loss: float,
    leverage: float,
    contract_size: float,
    quote_to_account_rate: float = 1.0,
    volume_step: float = 0.01,
    min_volume: float = 0.01,
    max_volume: float = 100.0,
) -> dict[str, Any]:
    """Size a CFD position using contract economics and round DOWN to broker step.

    quote_to_account_rate converts one unit of the instrument's quote currency
    (normally USD) into the account currency. Supply the broker's current rate.
    """
    symbol = symbol.upper().strip()
    side = side.upper().strip()
    if symbol not in {"XAUUSD", "BTCUSD"}:
        raise ValueError("Only XAUUSD and BTCUSD are supported.")
    if side not in {"BUY", "SELL"}:
        raise ValueError("Side must be BUY or SELL.")
    values = {
        "balance": balance, "risk_pct": risk_pct, "entry": entry,
        "stop_loss": stop_loss, "leverage": leverage,
        "contract_size": contract_size, "quote_to_account_rate": quote_to_account_rate,
        "volume_step": volume_step, "min_volume": min_volume, "max_volume": max_volume,
    }
    if any(not isinstance(v, (int, float)) or v <= 0 for v in values.values()):
        raise ValueError("All numeric inputs must be greater than zero.")
    if risk_pct > 5:
        raise ValueError("Risk per trade cannot exceed the 5% safety cap.")
    if (side == "BUY" and stop_loss >= entry) or (side == "SELL" and stop_loss <= entry):
        raise ValueError("Stop-loss must be below entry for BUY and above entry for SELL.")
    if min_volume > max_volume or volume_step > max_volume:
        raise ValueError("Broker volume limits are inconsistent.")

    stop_distance = abs(entry - stop_loss)
    risk_budget = balance * risk_pct / 100.0
    loss_per_lot = stop_distance * contract_size * quote_to_account_rate
    raw_lots = risk_budget / loss_per_lot
    stepped_lots = floor((raw_lots + 1e-12) / volume_step) * volume_step
    lots = min(max_volume, round(stepped_lots, 8))
    if lots < min_volume:
        return {
            "status": "BELOW_MINIMUM_VOLUME", "symbol": symbol, "side": side,
            "recommended_lot": 0.0, "raw_lot": raw_lots,
            "risk_budget": round(risk_budget, 2),
            "estimated_loss_at_minimum_lot": round(min_volume * loss_per_lot, 2),
            "note": "Minimum broker volume would exceed the selected risk budget. Do not force the trade.",
        }

    estimated_loss = lots * loss_per_lot
    notional_account = lots * contract_size * entry * quote_to_account_rate
    margin_required = notional_account / leverage
    return {
        "status": "OK", "symbol": symbol, "side": side,
        "recommended_lot": lots, "raw_lot": round(raw_lots, 8),
        "stop_distance": round(stop_distance, 8),
        "risk_budget": round(risk_budget, 2),
        "estimated_loss": round(estimated_loss, 2),
        "unused_risk": round(max(0.0, risk_budget - estimated_loss), 2),
        "estimated_margin": round(margin_required, 2),
        "notional_value": round(notional_account, 2),\n        "margin_method": margin_method,
        "leverage": f"1:{int(leverage) if float(leverage).is_integer() else leverage}",
        "quote_to_account_rate": quote_to_account_rate,
        "contract_size": contract_size,
        "volume_step": volume_step,
        "note": "Estimate only. Confirm contract size, conversion rate, margin rules, commission and slippage with your broker.",
    }
