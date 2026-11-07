"""Read-only investigation of stored setup outcome classifications.

Requires DATABASE_URL. This script never updates, inserts, or deletes records.
It reports outcome distributions and review candidates. Candidate rows are not
automatically labeled incorrect: SL can follow partial TP progression, and older
terminal TP records may predate progression metadata.
"""
from __future__ import annotations

import os

import psycopg
from psycopg.rows import dict_row


def database_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise SystemExit("DATABASE_URL is required; read-only audit not run.")
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return url


def _print_rows(title: str, rows: list[dict]) -> None:
    print(f"\n{title}: {len(rows)}")
    for row in rows:
        print(
            f"id={row['id']} {row['symbol']} {row['timeframe']} {row['side']} "
            f"status={row['status']} reached_target={row['reached_target']} "
            f"targets_hit={row['targets_hit']} outcome_price={row['outcome_price']} "
            f"take_profits={row['take_profits']}"
        )


def main() -> None:
    with psycopg.connect(database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        total = conn.execute(
            "SELECT COUNT(*) AS total FROM goldsight_setup_history"
        ).fetchone()["total"]
        print(f"Total stored setups: {total}")

        statuses = conn.execute(
            """SELECT status, COUNT(*) AS count
               FROM goldsight_setup_history
               GROUP BY status
               ORDER BY status"""
        ).fetchall()
        print("\nOutcome/status distribution:")
        for row in statuses:
            print(f"  {row['status']}: {row['count']}")

        progression = conn.execute(
            """SELECT
                 COUNT(*) FILTER (WHERE reached_target IS NOT NULL) AS rows_with_reached_target,
                 COUNT(*) FILTER (WHERE reached_target > 0) AS rows_with_positive_reached_target,
                 COUNT(*) FILTER (
                   WHERE jsonb_typeof(targets_hit) = 'array'
                     AND jsonb_array_length(targets_hit) > 0
                 ) AS rows_with_targets_hit
               FROM goldsight_setup_history"""
        ).fetchone()
        print("\nTP progression coverage:")
        for key, value in progression.items():
            print(f"  {key}: {value}")

        sl_after_tp = conn.execute(
            """SELECT id, symbol, timeframe, side, status, take_profits,
                      reached_target, targets_hit, outcome_at, outcome_price
               FROM goldsight_setup_history
               WHERE status = 'SL_HIT'
                 AND (COALESCE(reached_target, 0) > 0
                      OR (jsonb_typeof(targets_hit) = 'array'
                          AND jsonb_array_length(targets_hit) > 0))
               ORDER BY outcome_at NULLS LAST, id"""
        ).fetchall()
        _print_rows(
            "Review candidates: SL_HIT with recorded TP progression "
            "(may represent TP partials followed by a later stop)",
            sl_after_tp,
        )

        tp_without_metadata = conn.execute(
            """SELECT id, symbol, timeframe, side, status, take_profits,
                      reached_target, targets_hit, outcome_at, outcome_price
               FROM goldsight_setup_history
               WHERE status LIKE 'TP%_HIT'
                 AND COALESCE(reached_target, 0) = 0
                 AND (targets_hit IS NULL OR targets_hit = '[]'::jsonb)
               ORDER BY outcome_at NULLS LAST, id"""
        ).fetchall()
        _print_rows(
            "Review candidates: terminal TP status without progression metadata "
            "(may be legacy rows recorded before progression fields were populated)",
            tp_without_metadata,
        )

        print(
            "\nInterpretation: these groups flag missing or notable metadata for review; "
            "they do not establish incorrect outcome classifications."
        )
        print("READ-ONLY AUDIT COMPLETE: no rows changed.")


if __name__ == "__main__":
    main()
