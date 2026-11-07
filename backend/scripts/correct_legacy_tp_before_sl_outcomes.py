"""Safely correct legacy SL_HIT rows that explicitly recorded TP progression.

Default behavior is read-only. Pass --apply to change only rows with confirmed
progression metadata. outcome_at is intentionally retained: the schema stores
only the final resolution timestamp, not the individual TP-touch timestamp.
"""
from __future__ import annotations

import argparse
import json
import os

import psycopg
from psycopg.rows import dict_row


def database_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise SystemExit("DATABASE_URL is required; correction not run.")
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return url


def candidates(conn) -> list[dict]:
    rows = conn.execute(
        """SELECT id, symbol, timeframe, side, status, take_profits,
                  reached_target, targets_hit, outcome_at, outcome_price
           FROM goldsight_setup_history
           WHERE status = 'SL_HIT'
             AND COALESCE(reached_target, 0) > 0
             AND jsonb_typeof(targets_hit) = 'array'
             AND jsonb_array_length(targets_hit) > 0
           ORDER BY outcome_at NULLS LAST, id"""
    ).fetchall()
    valid = []
    for row in rows:
        targets = [float(v) for v in (row["take_profits"] or [])]
        indices = sorted({int(v) for v in (row["targets_hit"] or []) if int(v) >= 0})
        if not targets or not indices:
            continue
        highest = indices[-1]
        if highest >= len(targets):
            continue
        # reached_target is a count; targets_hit stores zero-based indices.
        if int(row["reached_target"] or 0) < highest + 1:
            continue
        row["corrected_status"] = f"TP{highest + 1}_HIT"
        row["corrected_price"] = targets[highest]
        row["highest_target_index"] = highest
        valid.append(row)
    return valid


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply eligible status/price corrections.")
    args = parser.parse_args()
    with psycopg.connect(database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        rows = candidates(conn)
        print(f"Eligible legacy SL_HIT rows with TP progression: {len(rows)}")
        for row in rows:
            print(
                f"id={row['id']} {row['symbol']} {row['timeframe']} {row['side']} "
                f"old=SL_HIT new={row['corrected_status']} "
                f"target_price={row['corrected_price']} outcome_at_retained={row['outcome_at']}"
            )
        if not args.apply:
            print("DRY RUN: no rows changed. Re-run with --apply to update.")
            return
        for row in rows:
            conn.execute(
                """UPDATE goldsight_setup_history
                   SET status=%s, outcome_price=%s
                   WHERE id=%s AND status='SL_HIT'""",
                (row["corrected_status"], row["corrected_price"], row["id"]),
            )
        conn.commit()
        print(f"APPLIED: corrected {len(rows)} rows. outcome_at timestamps retained.")


if __name__ == "__main__":
    main()
