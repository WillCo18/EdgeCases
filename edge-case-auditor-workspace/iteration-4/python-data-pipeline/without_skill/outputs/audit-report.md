# Audit Report: Python CSV-to-Postgres Data Pipeline

## Overview

This report reviews a Python data pipeline that reads CSV files from a folder every 15 minutes, cleans and inserts them into PostgreSQL, archives the originals, and generates a daily summary report. Notifications are sent to Slack.

---

## Issues Found

### 1. Hardcoded Credentials in .env (Security - High)

**File:** `.env`

The `.env` file contains a plaintext database password (`password123`) and a Slack webhook URL. If this file is committed to version control, credentials are exposed. There is no `.gitignore` shown, so it is unclear whether `.env` is excluded from the repository.

**Recommendation:** Ensure `.env` is listed in `.gitignore`. Use a secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault) for production deployments rather than a flat `.env` file. Replace `password123` with a strong, randomly generated password.

---

### 2. No Error Handling or Retry Logic (Reliability - High)

**File:** `pipeline.py` -- `process_csv()`, `run_pipeline()`

The entire pipeline has no `try/except` blocks. If any single CSV is malformed, has missing columns, or the database connection fails, the whole pipeline crashes. Specifically:

- `pd.read_csv(filepath)` will raise on malformed CSVs.
- `df['amount'].astype(float)` will raise on non-numeric values.
- `pd.to_datetime(df['date'])` will raise on unparseable dates.
- `psycopg2.connect()` will raise if the database is unreachable.
- `requests.post()` will raise on network errors.
- `os.rename()` will raise if the archive directory does not exist.

A single failure in one file stops all remaining files from being processed.

**Recommendation:** Wrap `process_csv()` in a try/except inside the loop. Log errors per file and continue with the remaining files. Add retry logic (e.g., `tenacity` library) for transient database and network failures.

---

### 3. No Database Transaction Rollback (Data Integrity - High)

**File:** `pipeline.py` -- `process_csv()`

If an error occurs partway through the `for _, row in df.iterrows()` loop (e.g., a constraint violation on row 500 of 1000), `conn.commit()` is never called but neither is `conn.rollback()`. The connection is left in a broken state. Worse, if the process crashes, the file has not yet been archived, so on the next run it will be re-processed, potentially causing duplicate inserts for the rows that succeeded before the error.

**Recommendation:** Use a context manager or explicit try/except/finally to ensure `conn.rollback()` is called on failure and `conn.close()` is always called. Consider wrapping the entire file's inserts in a single transaction so it is all-or-nothing.

---

### 4. Row-by-Row Inserts Are Extremely Slow (Performance - High)

**File:** `pipeline.py` -- `process_csv()`

Using `df.iterrows()` with individual `INSERT` statements is the slowest possible way to load data into PostgreSQL. For large CSVs (e.g., 100K+ rows), this will be orders of magnitude slower than bulk methods.

**Recommendation:** Use `psycopg2.extras.execute_values()` for batch inserts, or use `COPY` via `cursor.copy_expert()` or `pandas` + `sqlalchemy` with `to_sql(method='multi')`. This can improve throughput by 10-100x.

---

### 5. No Duplicate Detection (Data Integrity - Medium)

**File:** `pipeline.py` -- `process_csv()`

If the pipeline crashes after inserting rows but before archiving the file (`os.rename`), the file remains in the input directory and will be fully re-processed on the next run, creating duplicate records.

**Recommendation:** Add a unique constraint or deduplication key to the `transactions` table (e.g., a composite key on `customer_name`, `amount`, `date`, `category`, `region`, or a hash column). Use `INSERT ... ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE` to make inserts idempotent.

---

### 6. No Input Validation or Schema Enforcement (Reliability - Medium)

**File:** `pipeline.py` -- `process_csv()`

The code assumes every CSV has exactly the columns `amount`, `date`, `customer_name`, `category`, and `region`. If a CSV has missing columns, extra columns, or different casing, the pipeline will crash with a `KeyError`.

**Recommendation:** Validate the DataFrame's columns after reading the CSV. Reject or quarantine files that do not match the expected schema. Consider logging a clear error message identifying which columns are missing.

---

### 7. No Logging (Operational - Medium)

**File:** `pipeline.py`

The pipeline uses `print()` for output. In a server environment, `print()` output may be lost unless stdout is explicitly captured. There is no structured logging, no log levels, no timestamps in log output, and no way to trace issues after the fact.

**Recommendation:** Replace `print()` with Python's `logging` module. Configure a file handler and/or a structured logging format (e.g., JSON lines). Include timestamps, file names, record counts, and error tracebacks.

---

### 8. Reports Directory May Not Exist (Reliability - Medium)

**File:** `pipeline.py` -- `generate_daily_report()`

The report is written to `./reports/daily_YYYYMMDD.csv` but the `reports` directory may not exist, which would cause a `FileNotFoundError`.

**Recommendation:** Use `os.makedirs('./reports', exist_ok=True)` before writing the report, or make the reports directory configurable via an environment variable.

---

### 9. Archive Directory May Not Exist (Reliability - Medium)

**File:** `pipeline.py` -- `process_csv()`

Similarly, `CSV_ARCHIVE_DIR` (`./data/processed`) may not exist. `os.rename()` will fail if the target directory is missing.

**Recommendation:** Ensure the archive directory exists at startup with `os.makedirs(archive_dir, exist_ok=True)`.

---

### 10. No Concurrency Safety (Reliability - Medium)

**File:** `pipeline.py`

If the pipeline takes longer than 15 minutes to complete (e.g., due to a very large batch of files), `schedule` will start a second run while the first is still running. This can cause race conditions: two processes reading the same CSV, double inserts, or file-move conflicts.

**Recommendation:** Add a lock mechanism (e.g., a file lock with `filelock` library, or a simple boolean flag) to prevent overlapping runs. Alternatively, check if a run is already in progress before starting a new one.

---

### 11. Slack Notification Failure Blocks Pipeline (Reliability - Low)

**File:** `pipeline.py` -- `run_pipeline()`, `generate_daily_report()`

If the Slack webhook is unreachable or returns an error, `requests.post()` will raise an exception. This means a Slack outage could prevent the pipeline from completing, even though the actual data processing succeeded.

**Recommendation:** Wrap Slack calls in try/except and log the failure rather than crashing the pipeline.

---

### 12. No Health Check or Monitoring (Operational - Low)

**File:** `pipeline.py`

There is no health check endpoint, no heartbeat, and no mechanism for external monitoring tools to verify the pipeline is alive. If the `while True` loop crashes silently, nobody will know until data stops flowing.

**Recommendation:** Consider running the pipeline under a process manager (e.g., systemd, supervisord) that restarts on crash. Add a heartbeat ping to an uptime monitoring service. Consider a `/health` endpoint if deploying alongside a web server.

---

### 13. Database Connection Not Pooled (Performance - Low)

**File:** `pipeline.py` -- `get_db_connection()`

A new database connection is opened and closed for every single CSV file. Connection establishment has overhead (TCP handshake, authentication, SSL negotiation).

**Recommendation:** Use a connection pool (e.g., `psycopg2.pool.SimpleConnectionPool` or `sqlalchemy` engine with pooling) to reuse connections across files.

---

### 14. `requirements.txt` Not Pinned (Reproducibility - Low)

**File:** `requirements.txt`

Dependencies are listed without version pins (e.g., `pandas` instead of `pandas==2.1.4`). This means future installs could pull breaking changes.

**Recommendation:** Pin all dependency versions. Use `pip freeze > requirements.txt` or a tool like `pip-tools` to generate a locked requirements file.

---

### 15. Relative Paths Are Fragile (Reliability - Low)

**Files:** `.env`, `pipeline.py`

`CSV_INPUT_DIR=./data/incoming` and `report_path = "./reports/..."` use relative paths. These depend on the working directory at runtime, which may differ depending on how the script is launched (cron, systemd, manual).

**Recommendation:** Use absolute paths in configuration, or resolve relative paths against the script's directory using `os.path.dirname(os.path.abspath(__file__))`.

---

## Summary

| Severity | Count |
|----------|-------|
| High     | 4     |
| Medium   | 6     |
| Low      | 5     |

The pipeline has a working structure but is not production-ready. The most critical issues are the lack of error handling (which will cause the pipeline to crash on any malformed input or transient failure), the absence of transaction rollback (risking partial inserts and data corruption), the row-by-row insert performance problem, and the credential management approach. Addressing the high and medium severity items is strongly recommended before deploying to a server.
