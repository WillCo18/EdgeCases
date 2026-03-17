# Audit Report: Python Data Pipeline

**Project:** CSV-to-Postgres Data Pipeline with Daily Reporting
**Files reviewed:** `pipeline.py`, `requirements.txt`, `.env`
**Date:** 2026-03-16

---

## Executive Summary

The pipeline reads CSVs from a folder every 15 minutes, cleans them, inserts rows into PostgreSQL, archives the files, and sends Slack notifications. A daily report job also runs at 08:00. The code is concise and readable, but has several issues ranging from **critical security and data-integrity problems** to operational gaps that will cause pain in production.

---

## Critical Issues

### 1. Credentials committed in `.env` (Security)
- **File:** `.env`
- The `.env` file contains a plaintext database password (`password123`) and a Slack webhook URL. If this file is checked into version control, credentials are exposed.
- **There is no `.gitignore` file in the project** to prevent accidental commits.
- **Recommendation:** Add a `.gitignore` that excludes `.env`. Use a secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault) or at minimum environment variables injected by the deployment system. The password `password123` is trivially guessable and must be changed before production.

### 2. No error handling anywhere (Reliability)
- **File:** `pipeline.py`, throughout
- If any single CSV is malformed, has missing columns, or contains unparseable data, the entire `run_pipeline()` call crashes. There is:
  - No `try/except` around `process_csv()`.
  - No `try/except` around individual row inserts.
  - No `try/except` around the Slack notification POST.
  - No `try/except` around the DB connection.
- A single bad file will halt processing of all subsequent files in that cycle.
- **Recommendation:** Wrap `process_csv()` in a try/except inside the loop. Log errors per file and continue processing remaining files. Add a dead-letter/quarantine folder for files that fail.

### 3. No database transaction safety (Data Integrity)
- **File:** `pipeline.py`, lines 25-38
- If the process crashes partway through `iterrows()`, some rows will be committed (because `conn.commit()` hasn't been called yet -- actually they won't be committed, but the file will not have been archived). However, on the next run the same file will be reprocessed, leading to **duplicate inserts** if the previous partial run's connection committed anything, or if `os.rename` partially happened.
- There is no idempotency mechanism (e.g., deduplication key, upsert, or tracking table).
- **Recommendation:** Use a unique constraint or `ON CONFLICT` clause to prevent duplicates. Alternatively, track processed filenames in a database table and skip already-processed files.

### 4. File archival before commit confirmation (Data Integrity)
- **File:** `pipeline.py`, lines 36-42
- The code commits the DB transaction, then closes the connection, then moves the file. If `os.rename()` fails (e.g., archive directory does not exist, permission error), the data is in the DB but the file stays in the input directory, causing **duplicate inserts** on the next run.
- Conversely, if the process is killed between `conn.commit()` and `os.rename()`, the same duplication occurs.
- **Recommendation:** Either (a) implement idempotent inserts, or (b) track processed files in the DB within the same transaction as the data insert.

---

## Major Issues

### 5. No logging (Observability)
- **File:** `pipeline.py`
- The code uses only `print()` statements. In a long-running server process, stdout may not be captured or may be lost.
- **Recommendation:** Use Python's `logging` module with appropriate levels (INFO, ERROR, WARNING). Configure output to a file and/or a log aggregation service. Include timestamps, file names, and record counts.

### 6. Row-by-row inserts are extremely slow (Performance)
- **File:** `pipeline.py`, lines 28-34
- `df.iterrows()` with individual `INSERT` statements is the slowest possible way to load data into Postgres. For large CSVs, this will be a bottleneck.
- **Recommendation:** Use `psycopg2.extras.execute_batch()`, `execute_values()`, or `COPY` via `copy_expert()`. Alternatively, use SQLAlchemy's `to_sql()` with `method='multi'`. This can yield 10-100x speedups.

### 7. No input validation or schema enforcement (Data Quality)
- **File:** `pipeline.py`, lines 18-23
- The code assumes every CSV has exactly these columns: `amount`, `date`, `customer_name`, `category`, `region`. If any column is missing or named differently, it crashes with a KeyError.
- There is no validation that `amount` values are positive, that `date` values are within a reasonable range, or that `customer_name` is non-empty after stripping.
- NaN/null values are not handled -- `astype(float)` will fail on non-numeric strings in the `amount` column.
- **Recommendation:** Validate the DataFrame schema before processing. Handle or reject rows with missing/invalid data. Consider using a validation library like `pandera` or `great_expectations`.

### 8. Reports directory may not exist (Reliability)
- **File:** `pipeline.py`, line 81
- The report is saved to `./reports/daily_YYYYMMDD.csv`, but the `reports/` directory is never created.
- **Recommendation:** Add `os.makedirs('./reports', exist_ok=True)` before writing, or better, make the reports directory configurable via `.env`.

### 9. Archive directory may not exist (Reliability)
- **File:** `pipeline.py`, line 41-42
- `os.rename()` will fail if `CSV_ARCHIVE_DIR` does not exist.
- **Recommendation:** Create the archive directory on startup with `os.makedirs(archive_dir, exist_ok=True)`.

### 10. Slack notification failure kills the pipeline run (Reliability)
- **File:** `pipeline.py`, lines 58-60
- If the Slack webhook is unreachable or returns an error, `requests.post()` could raise an exception, and the successful processing is never reported. Worse, if this is the call in `run_pipeline()`, it means data was already committed but the pipeline appears to have failed.
- **Recommendation:** Wrap Slack calls in try/except. Slack notifications should never cause pipeline failure.

---

## Moderate Issues

### 11. No connection pooling (Performance / Reliability)
- **File:** `pipeline.py`, lines 13-14, 25-38
- A new database connection is opened and closed for every single CSV file. Under load, this is wasteful.
- **Recommendation:** Use a connection pool (e.g., `psycopg2.pool.SimpleConnectionPool`) or open one connection per pipeline run.

### 12. Pinned dependency versions missing (Reproducibility)
- **File:** `requirements.txt`
- No versions are pinned. A future `pip install` could pull incompatible versions.
- **Recommendation:** Pin versions (e.g., `pandas==2.2.0`). Use `pip freeze > requirements.txt` or a tool like `pip-compile`.

### 13. No graceful shutdown handling (Operations)
- **File:** `pipeline.py`, lines 95-97
- The `while True` loop has no signal handling. Killing the process (e.g., via `systemctl stop` or `Ctrl+C`) during a database insert could leave a transaction in a bad state.
- **Recommendation:** Add a signal handler for SIGTERM/SIGINT that sets a flag to stop the loop after the current job completes.

### 14. `os.rename()` fails across filesystems (Portability)
- **File:** `pipeline.py`, line 42
- `os.rename()` cannot move files across filesystem boundaries (e.g., if input and archive are on different volumes).
- **Recommendation:** Use `shutil.move()` instead.

### 15. Schedule library runs in a single thread (Scalability)
- **File:** `pipeline.py`, lines 89-97
- The `schedule` library is single-threaded. If `run_pipeline()` takes longer than 15 minutes (e.g., very large files), runs will stack up and be delayed.
- **Recommendation:** For production, consider a proper scheduler like `cron`, `systemd timers`, `Celery`, or `APScheduler`. Alternatively, add a lock to prevent overlapping runs.

### 16. Relative paths depend on working directory (Operations)
- **File:** `.env`, `pipeline.py` line 81
- `CSV_INPUT_DIR=./data/incoming`, `CSV_ARCHIVE_DIR=./data/processed`, and `./reports/` are all relative paths. If the process is started from a different directory (common with systemd or cron), the paths will resolve incorrectly.
- **Recommendation:** Use absolute paths in `.env`, or resolve relative paths against the script's directory using `os.path.dirname(os.path.abspath(__file__))`.

---

## Minor Issues / Suggestions

### 17. No health check or heartbeat mechanism
- If the scheduler loop hangs or the process dies silently, nobody is alerted.
- **Recommendation:** Add a heartbeat (e.g., periodic ping to an uptime monitor like Healthchecks.io or a Slack heartbeat message).

### 18. Daily report query uses `CURRENT_DATE` but report runs at 08:00
- **File:** `pipeline.py`, lines 68-76
- The query filters `WHERE date >= CURRENT_DATE - INTERVAL '1 day'`. Depending on timezone settings of Postgres vs. the server, this may not capture the intended 24-hour window.
- **Recommendation:** Be explicit about timezone handling. Consider using `CURRENT_TIMESTAMP AT TIME ZONE 'UTC'` or parameterizing the date range.

### 19. No retry logic for transient failures
- Network issues to Postgres or Slack could cause one-off failures that would succeed on retry.
- **Recommendation:** Add retry logic with exponential backoff for DB connections and HTTP requests (e.g., `tenacity` library or `requests` adapters with `urllib3.util.retry`).

### 20. Database table creation not handled
- The code assumes the `transactions` table already exists. There is no migration or schema setup.
- **Recommendation:** Include a schema migration script or at minimum document the expected table DDL.

---

## Summary of Recommendations by Priority

| Priority | Issue | Effort |
|----------|-------|--------|
| **P0 - Do before running** | Add `.gitignore`, change DB password, remove credentials from repo | Low |
| **P0 - Do before running** | Add error handling around `process_csv()` and Slack calls | Low |
| **P0 - Do before running** | Ensure archive and reports directories exist | Low |
| **P1 - Do soon** | Add duplicate prevention / idempotent inserts | Medium |
| **P1 - Do soon** | Add logging instead of print statements | Low |
| **P1 - Do soon** | Validate CSV schema before processing | Medium |
| **P1 - Do soon** | Use absolute paths or resolve relative paths | Low |
| **P2 - Important** | Switch to bulk inserts for performance | Medium |
| **P2 - Important** | Pin dependency versions | Low |
| **P2 - Important** | Add graceful shutdown handling | Low |
| **P3 - Nice to have** | Connection pooling | Low |
| **P3 - Nice to have** | Replace `schedule` with a production scheduler | Medium |
| **P3 - Nice to have** | Add retry logic | Low |
| **P3 - Nice to have** | Add health checks | Low |
