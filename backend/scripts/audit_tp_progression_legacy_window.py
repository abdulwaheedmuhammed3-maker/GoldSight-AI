"""Read-only age-window audit for terminal TP records missing progression metadata.

Requires DATABASE_URL. This script only SELECTs from setup history; it never
updates, inserts, or deletes records. Monthly grouping helps determine whether
missing progression metadata is concentrated in a legacy period.
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


def main() -> None:
    with psycopg.connect(database_url(), connect_timeout=8, row_factory=dict_row) as conn:
        summary = conn.execute(
            """SELECT COUNT(*) AS total,
                      MIN(detected_at) AS oldest_detected_at,
                      MAX(detected_at) AS newest_detected_at,
                      MIN(outcome_at) AS oldest_outcome_at,
                      MAX(outcome_at) AS newest_outcome_at
               FROM goldsight_setup_history
               WHERE status LIKE 'TP%_HIT'
                 AND COALESCE(reached_target, 0) = 0
                 AND (targets_hit IS NULL OR targets_hit = '[]'::jsonb)"""
        ).fetchone()
        print("Terminal TP records without progression metadata:")
        for key, value in summary.items():
            print(f"  {key}: {value}")

        monthly = conn.execute(
            """SELECT date_trunc('month', detected_at) AS detected_month,
                      COUNT(*) AS row_count,
                      COUNT(*) FILTER (WHERE status = 'TP1_HIT') AS tp1_count,
                      COUNT(*) FILTER (WHERE status = 'TP2_HIT') AS tp2_count,
                      COUNT(*) FILTER (WHERE status = 'TP3_HIT') AS tp3_count,
                      MIN(detected_at) AS first_detected_at,
                      MAX(detected_at) AS last_detected_at
               FROM goldsight_setup_history
               WHERE status LIKE 'TP%_HIT'
                 AND COALESCE(reached_target, 0) = 0
                 AND (targets_hit IS NULL OR targets_hit = '[]'::jsonb)
               GROUP BY date_trunc('month', detected_at)
               ORDER BY detected_month"""
        ).fetchall()
        print("\nMonthly distribution by detected_at (no metadata rows):")
        if not monthly:
            print("  None")
        for row in monthly:
            print(
                f"  month={row['detected_month']} total={row['row_count']} "
                f"TP1={row['tp1_count']} TP2={row['tp2_count']} TP3={row['tp3_count']} "
                f"first={row['first_detected_at']} last={row['last_detected_at']}"
            )

        by_status = conn.execute(
            """SELECT status, COUNT(*) AS row_count,
                      MIN(detected_at) AS first_detected_at,
                      MAX(detected_at) AS last_detected_at
               FROM goldsight_setup_history
               WHERE status LIKE 'TP%_HIT'
                 AND COALESCE(reached_target, 0) = 0
                 AND (targets_hit IS NULL OR targets_hit = '[]'::jsonb)
               GROUP BY status
               ORDER BY status"""
        ).fetchall()
        print("\nStatus summary:")
        for row in by_status:
            print(
                f"  {row['status']}: {row['row_count']} "
                f"first={row['first_detected_at']} last={row['last_detected_at']}"
            )

        print("\nREAD-ONLY AGE-WINDOW AUDIT COMPLETE: no rows changed.")


if __name__ == "__main__":
    main()
