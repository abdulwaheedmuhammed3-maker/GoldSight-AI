from app import instrument_audit


def test_audit_starts_in_background_and_returns_progress(monkeypatch):
    class FakeThread:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        def start(self):
            return None

    monkeypatch.setattr(instrument_audit, "Thread", FakeThread)
    monkeypatch.setattr(instrument_audit, "_save_job", lambda job: False)
    monkeypatch.setattr(instrument_audit, "_load_active_job", lambda: None)
    monkeypatch.setattr(instrument_audit, "_load_latest_job", lambda: None)
    instrument_audit._JOBS.clear()
    instrument_audit._ACTIVE_JOB = None
    monkeypatch.setattr(instrument_audit, "_quote_snapshot", lambda: {
        symbol: {"symbol": symbol, "quote": {}, "timeframes": {}}
        for symbol in instrument_audit.SYMBOLS
    })
    result = instrument_audit.start_or_get_audit()
    assert result["status"] == "running"
    assert result["audit_id"]
    assert result["total_checks"] == len(instrument_audit.SYMBOLS) * 5
    assert result["persistence"] == "memory_only"
    instrument_audit._LOCAL_RUNNING.discard(result["audit_id"])


def test_unknown_audit_id_returns_none(monkeypatch):
    monkeypatch.setattr(instrument_audit, "_load_job", lambda job_id: None)
    assert instrument_audit.get_audit("not-a-real-audit-id") is None


def test_audit_progress_is_saved_after_each_completed_check(monkeypatch):
    saved = []
    monkeypatch.setattr(instrument_audit, "_save_job", lambda job: saved.append(job["completed_checks"]) or True)
    job = {
        "audit_id": "audit-test", "status": "running", "completed_checks": 0,
        "total_checks": 1, "results": {
            instrument_audit.SYMBOLS[0]: {
                "symbol": instrument_audit.SYMBOLS[0], "quote": {"status": "LIVE"}, "timeframes": {}
            }
        }, "instruments": [], "_persisted": False,
    }
    instrument_audit._JOBS["audit-test"] = job
    monkeypatch.setattr(instrument_audit, "fetch_market", lambda *args: {
        "candles": [], "provider": "test", "provider_symbol": "TEST"
    })
    monkeypatch.setattr(instrument_audit, "normalize_candles", lambda candles: candles)
    monkeypatch.setattr(instrument_audit, "SYMBOLS", (instrument_audit.SYMBOLS[0],))
    monkeypatch.setattr(instrument_audit, "TIMEFRAMES", ("5m",))
    instrument_audit._LOCAL_RUNNING.add("audit-test")
    instrument_audit._run_audit("audit-test")
    assert saved
    assert job["completed_checks"] == 1
    assert job["status"] == "complete"
    instrument_audit._JOBS.pop("audit-test", None)



def test_main_audit_reopens_latest_completed_job_without_starting_new(monkeypatch):
    completed = {
        "audit_id": "saved-audit-123", "status": "complete",
        "started_at": "2026-11-10T15:00:00+00:00",
        "completed_checks": 50, "total_checks": 50, "_persisted": True,
    }
    monkeypatch.setattr(instrument_audit, "_load_active_job", lambda: None)
    monkeypatch.setattr(instrument_audit, "_load_latest_job", lambda: completed)
    monkeypatch.setattr(instrument_audit, "_save_job", lambda job: True)
    instrument_audit._JOBS.clear()
    result = instrument_audit.start_or_get_audit()
    assert result["audit_id"] == "saved-audit-123"
    assert result["status"] == "complete"
    assert result["completed_checks"] == 50


def test_force_new_creates_a_different_audit(monkeypatch):
    class FakeThread:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        def start(self):
            return None

    monkeypatch.setattr(instrument_audit, "Thread", FakeThread)
    monkeypatch.setattr(instrument_audit, "_save_job", lambda job: True)
    monkeypatch.setattr(instrument_audit, "_quote_snapshot", lambda: {
        symbol: {"symbol": symbol, "quote": {}, "timeframes": {}}
        for symbol in instrument_audit.SYMBOLS
    })
    instrument_audit._JOBS.clear()
    instrument_audit._ACTIVE_JOB = None
    result = instrument_audit.start_or_get_audit(force_new=True)
    assert result["status"] == "running"
    assert result["audit_id"]
    instrument_audit._LOCAL_RUNNING.discard(result["audit_id"])
    instrument_audit._JOBS.clear()
    instrument_audit._ACTIVE_JOB = None



def test_audit_preserves_provider_history_diagnostics(monkeypatch):
    diagnostics = {
        "requested_interval": "5m",
        "returned_rows": 120,
        "valid_unique_candles": 120,
        "provider_raw_row_order": "descending",
        "newest_candle_age_seconds": 5432.1,
    }
    symbol = instrument_audit.SYMBOLS[0]
    job = {
        "audit_id": "audit-history-diagnostics",
        "status": "running",
        "completed_checks": 0,
        "total_checks": 1,
        "results": {
            symbol: {
                "symbol": symbol,
                "quote": {"status": "LIVE"},
                "timeframes": {},
            }
        },
        "instruments": [],
        "_persisted": False,
    }
    monkeypatch.setattr(instrument_audit, "_save_job", lambda job: False)
    monkeypatch.setattr(instrument_audit, "fetch_market", lambda *args: {
        "candles": [],
        "provider": "SiftingIO aggregated commodities reference feed",
        "provider_symbol": "XAUUSD",
        "history_diagnostics": diagnostics,
    })
    monkeypatch.setattr(instrument_audit, "normalize_candles", lambda candles: candles)
    monkeypatch.setattr(instrument_audit, "SYMBOLS", (symbol,))
    monkeypatch.setattr(instrument_audit, "TIMEFRAMES", ("5m",))
    instrument_audit._JOBS["audit-history-diagnostics"] = job
    instrument_audit._LOCAL_RUNNING.add("audit-history-diagnostics")

    instrument_audit._run_audit("audit-history-diagnostics")

    entry = job["results"][symbol]["timeframes"]["5m"]
    assert entry["provider_diagnostics"] == diagnostics
    assert entry["status"] == "OFFLINE"
    instrument_audit._JOBS.pop("audit-history-diagnostics", None)
