"""Broker-configurable position sizing for CFDs. Calculation only; never places orders."""
from __future__ import annotations

from math import floor, isfinite
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
    max_volume: float = 1000.0,
    margin_per_lot_quote: float | None = None,
) -> dict[str, Any]:
    """Size a CFD position and round DOWN to the broker's volume step.

    quote_to_account_rate converts one unit of the quote currency (USD for
    XAUUSD) into the account currency (NGN for this Exness demo profile).
    """
    symbol = symbol.upper().strip()
    side = side.upper().strip()
    if symbol not in {"XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP"}:
        raise ValueError("Unsupported symbol for position sizing.")
    if side not in {"BUY", "SELL"}:
        raise ValueError("Side must be BUY or SELL.")

    values = {
        "balance": balance,
        "risk_pct": risk_pct,
        "entry": entry,
        "stop_loss": stop_loss,
        "leverage": leverage,
        "contract_size": contract_size,
        "quote_to_account_rate": quote_to_account_rate,
        "volume_step": volume_step,
        "min_volume": min_volume,
        "max_volume": max_volume,
    }
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or value <= 0 for value in values.values()):
        raise ValueError("All numeric inputs must be finite and greater than zero.")
    if risk_pct > 5:
        raise ValueError("Risk per trade cannot exceed the 5% safety cap.")
    if (side == "BUY" and stop_loss >= entry) or (side == "SELL" and stop_loss <= entry):
        raise ValueError("Stop-loss must be below entry for BUY and above entry for SELL.")
    if min_volume > max_volume or volume_step > max_volume:
        raise ValueError("Broker volume limits are inconsistent.")
    if margin_per_lot_quote is not None and (
        isinstance(margin_per_lot_quote, bool)
        or not isinstance(margin_per_lot_quote, (int, float))
        or not isfinite(margin_per_lot_quote)
        or margin_per_lot_quote <= 0
    ):
        raise ValueError("Margin per lot must be positive when supplied.")

    stop_distance = abs(entry - stop_loss)
    risk_budget = balance * risk_pct / 100.0
    loss_per_lot = stop_distance * contract_size * quote_to_account_rate
    if not all(isfinite(value) and value > 0 for value in (stop_distance, risk_budget, loss_per_lot)):
        raise ValueError("The supplied values exceed safe calculation limits.")
    raw_lots = risk_budget / loss_per_lot
    if not isfinite(raw_lots):
        raise ValueError("The calculated position size exceeds safe limits.")
    step_units = (raw_lots + 1e-12) / volume_step
    if not isfinite(step_units):
        raise ValueError("The calculated position size exceeds safe limits.")
    stepped_lots = floor(step_units) * volume_step
    if not isfinite(stepped_lots):
        raise ValueError("The calculated position size exceeds safe limits.")
    lots = min(max_volume, round(stepped_lots, 8))

    if lots < min_volume:
        return {
            "status": "BELOW_MINIMUM_VOLUME",
            "symbol": symbol,
            "side": side,
            "recommended_lot": 0.0,
            "raw_lot": round(raw_lots, 8),
            "risk_budget": round(risk_budget, 2),
            "estimated_loss_at_minimum_lot": round(min_volume * loss_per_lot, 2),
            "note": "Minimum broker volume would exceed the selected risk budget. Do not force the trade.",
        }

    estimated_loss = lots * loss_per_lot
    notional_account = lots * contract_size * entry * quote_to_account_rate
    if not isfinite(estimated_loss) or not isfinite(notional_account):
        raise ValueError("The estimated loss or notional value exceeds safe calculation limits.")
    if margin_per_lot_quote is not None:
        margin_required = lots * margin_per_lot_quote * quote_to_account_rate
        margin_method = "broker margin-per-lot reference"
    else:
        margin_required = notional_account / leverage
        margin_method = "notional divided by leverage estimate"
    if not isfinite(margin_required) or margin_required < 0:
        raise ValueError("The estimated margin exceeds safe calculation limits.")

    return {
        "status": "OK",
        "symbol": symbol,
        "side": side,
        "recommended_lot": lots,
        "raw_lot": round(raw_lots, 8),
        "stop_distance": round(stop_distance, 8),
        "risk_budget": round(risk_budget, 2),
        "estimated_loss": round(estimated_loss, 2),
        "unused_risk": round(max(0.0, risk_budget - estimated_loss), 2),
        "estimated_margin": round(margin_required, 2),
        "notional_value": round(notional_account, 2),
        "margin_method": margin_method,
        "leverage": f"1:{int(leverage) if float(leverage).is_integer() else leverage}",
        "quote_to_account_rate": quote_to_account_rate,
        "contract_size": contract_size,
        "volume_step": volume_step,
        "note": "Estimate only. Spread, commission, slippage, conversion and broker margin changes can alter the final result.",
    }
