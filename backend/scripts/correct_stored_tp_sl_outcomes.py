"""Audit and narrowly correct stored SL_HIT rows with complete TP progression.

Run with DATABASE_URL configured. Default is dry-run; pass --apply to write.
This intentionally does not guess outcomes from ambiguous OHLC history.
"""
from __future__ import annotations

import argparse
import json
import os

import psycopg
from psycopg.rows import dict_row


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply eligible corrections (default: dry-run)")
    args = parser.parse_args()
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise SystemExit("DATABASE_URL is required; no changes made.")
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]

    # Candidate rows must explicitly show all configured target indices reached.
    # Never infer a TP from the stop price or from unsequenced OHLC bars.
    query = """
        SELECT id, symbol, timeframe, side, status, take_profits,
               reached_target, targets_hit, outcome_at, outcome_price
        FROM goldsight_setup_history
        WHERE status = 'SL_HIT'
          AND reached_target IS NOT NULL
          AND jsonb_typeof(take_profits) = 'array'
          AND jsonb_array_length(take_profits) > 0
          AND reached_target >= jsonb_array_length(take_profits)
        ORDER BY outcome_at NULLS LAST, id
    """
    with psycopg.connect(url, connect_timeout=8, row_factory=dict_row) as conn:
        rows = conn.execute(query).fetchall()
        print(f"Eligible records found: {len(rows)}")
        for row in rows:
            targets = [float(x) for x in (row["take_profits"] or [])]
            print(
                f"id={row['id']} {row['symbol']} {row['timeframe']} {row['side']} "
                f"SL_HIT -> TP{len(targets)}_HIT; target_price={targets[-1]} "
                f"old_outcome_price={row['outcome_price']}"
            )
        if not args.apply:
            print("DRY RUN: no rows changed. Re-run with --apply to update eligible rows.")
            return
        if not rows:
            print("No eligible rows. Ambiguous records remain untouched.")
            return
        with conn.transaction():
            for row in rows:
                targets = [float(x) for x in (row["take_profits"] or [])]
                conn.execute(
                    """UPDATE goldsight_setup_history
                       SET status = %s, outcome_price = %s,
                           reached_target = %s,
                           targets_hit = %s::jsonb
                       WHERE id = %s AND status = 'SL_HIT'
                         AND reached_target >= jsonb_array_length(take_profits)""",
                    (
                        f"TP{len(targets)}_HIT",
                        targets[-1],
                        len(targets),
                        json.dumps(list(range(len(targets)))),
                        row["id"],
                    ),
                )
        print(f"Corrected {len(rows)} eligible records.")


if __name__ == "__main__":
    main()
