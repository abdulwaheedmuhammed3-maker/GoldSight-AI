from app.market import MarketUnavailable, _oanda_base, fetch_market


def test_oanda_is_default_for_supported_fx_but_offline_without_secrets(monkeypatch):
    monkeypatch.delenv("OANDA_API_TOKEN", raising=False)
    monkeypatch.delenv("OANDA_ACCOUNT_ID", raising=False)
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "oanda")
    try:
        fetch_market("EURUSD", "15m")
        assert False, "Expected missing OANDA credentials to fail closed"
    except MarketUnavailable as exc:
        assert "OANDA is not configured" in str(exc)


def test_oanda_environment_rejects_unknown_value(monkeypatch):
    monkeypatch.setenv("OANDA_ENVIRONMENT", "somewhere")
    try:
        _oanda_base()
        assert False, "Expected unsupported environment to be rejected"
    except MarketUnavailable as exc:
        assert "OANDA_ENVIRONMENT" in str(exc)


def test_oanda_environment_selects_practice_and_live_hosts(monkeypatch):
    monkeypatch.setenv("OANDA_ENVIRONMENT", "practice")
    assert _oanda_base() == "https://api-fxpractice.oanda.com"
    monkeypatch.setenv("OANDA_ENVIRONMENT", "live")
    assert _oanda_base() == "https://api-fxtrade.oanda.com"
