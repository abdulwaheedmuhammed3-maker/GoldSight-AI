from app import backtest


def _bar(timestamp, open_=100.0, high=100.5, low=99.5, close=100.0):
    return {
        "time": timestamp,
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": 10,
    }


def test_prepare_candles_sorts_deduplicates_and_rejects_invalid_ohlc():
    candles = [
        _bar(600, close=100.1),
        _bar(300, close=100.0),
        _bar(600, close=100.2),  # latest duplicate wins
        _bar(900, high=98.0, low=99.0),  # impossible OHLC
    ]

    bars, quality = backtest._prepare_candles(candles, "5m")

    assert [bar["time"] for bar in bars] == [300, 600]
    assert bars[-1]["close"] == 100.2
    assert quality["duplicate_timestamps_removed"] == 1
    assert quality["invalid_candles_removed"] == 1


def test_backtest_assumes_stop_first_when_stop_and_target_hit_same_bar(monkeypatch):
    candles = [_bar(i * 14400) for i in range(50)]
    calls = {"count": 0}

    def fake_analyze(*args, **kwargs):
        calls["count"] += 1
        if calls["count"] > 1:
            return {"side": "NO SETUP"}
        return {
            "side": "BUY",
            "signal_time": "2026-01-01T00:00:00+00:00",
            "stop_loss": 99.0,
            "take_profits": [101.0, 102.0, 103.0],
        }

    # First simulated entry candle touches both stop and target. OHLC cannot
    # establish intrabar ordering, so the conservative result must be a loss.
    candles[41] = _bar(41 * 14400, open_=100.0, high=102.0, low=98.0, close=100.5)
    monkeypatch.setattr(backtest, "analyze", fake_analyze)

    result = backtest.run_backtest(
        candles,
        "XAUUSD",
        "4h",
        spread=0.0,
        target_r=1,
        max_hold_bars=5,
    )

    assert result["trades"] >= 1
    assert result["trade_details"][0]["outcome"] == "STOP_AND_TARGET_SAME_BAR_STOP_ASSUMED"
    assert result["stop_loss_hits"] == 1
    assert result["stop_loss_rate_pct"] == 100.0
    assert result["target_hits"] == 0
    assert result["outcome_counts"]["STOP_AND_TARGET_SAME_BAR_STOP_ASSUMED"] == 1
    assert result["trade_details"][0]["gross_r"] == -1.0


def test_backtest_rejects_insufficient_history_with_data_quality():
    result = backtest.run_backtest(
        [_bar(i * 300) for i in range(20)],
        "BTCUSD",
        "5m",
        spread=None,
    )

    assert result["trades"] == 0
    assert result["data_quality"]["valid_candles"] == 20
    assert "At least 45" in result["reason"]


def test_backtest_uses_bounded_rolling_analysis_context(monkeypatch):
    from app import backtest as module

    candles = [_bar(i * 14400) for i in range(320)]
    seen_lengths = []

    def no_setup(analyzed_candles, *args, **kwargs):
        seen_lengths.append(len(analyzed_candles))
        return {"side": "NO SETUP"}

    monkeypatch.setattr(module, "analyze", no_setup)
    result = module.run_backtest(
        candles, "XAUUSD", "4h", spread=None,
        analysis_lookback_bars=240,
    )

    assert result["trades"] == 0
    assert max(seen_lengths) == 240
    assert result["candles_used"] == 320


def test_backtest_skips_zero_atr_windows_before_calling_strategy(monkeypatch):
    from app import backtest as module

    candles = [
        {"time": i * 300, "open": 100.0, "high": 100.0, "low": 100.0,
         "close": 100.0, "volume": 1}
        for i in range(60)
    ]
    calls = {"count": 0}

    def should_not_analyze(*args, **kwargs):
        calls["count"] += 1
        raise AssertionError("Zero-ATR bars must not reach either strategy analyzer.")

    monkeypatch.setattr(module, "analyze", should_not_analyze)
    result = module.run_backtest(
        candles, "XAUUSD", "5m", spread=None,
        analysis_lookback_bars=240,
    )

    assert calls["count"] == 0
    assert result["trades"] == 0
    assert result["skipped_for_zero_atr"] > 0
