# Audit Report: Python Data Pipeline

**Project:** CSV-to-Postgres Data Pipeline with Daily Reporting
**Files Reviewed:** `pipeline.py`, `requirements.txt`, `.env`
**Date:** 2026-03-16

---

## Executive Summary

This pipeline reads CSVs from a folder every 15 minutes, cleans data, inserts it into PostgreSQL, archives the files, and generates a daily report. The code is functional but has **several issues that will cause failures, data loss, or security problems in production**. The most critical are: no error handling anywhere, hardcoded credentials in `.env` committed to the project, and no duplicate-detection mechanism.

---

## Critical Issues

### 1. Zero Error Handling Throughout the Entire Pipeline

**Severity: Critical**
**File:** `pipeline.py`, all functions

There is no try/except anywhere. Any single failure will crash the entire long-running scheduler process:

- A malformed CSV (missing columns, bad encoding) will crash `process_csv()` and kill the scheduler loop.
- A database connection failure will crash the process.
- A network blip on the Slack webhook will crash `run_pipeline()`.
- `os.rename()` will fail if the archive directory doesn't exist, or if a file with the same name already exists in archive.

**Recommendation:** Wrap each `process_csv()` call in try/except. Wrap the Slack notification in try/except. Add a top-level exception handler in the scheduler loop. Log errors rather than crashing.

### 2. Database Connection Leaked on Any Error

**Severity: Critical**
**File:** `pipeline.py`, lines 25-38

If any exception occurs between `get_db_connection()` (line 25) and `conn.close()` (line 38) -- for example, a column is missing or a type conversion fails -- the connection is never closed. Over time with recurring failures, this will exhaust the PostgreSQL connection pool.

**Recommendation:** Use a context manager or try/finally:
```python
conn = get_db_connection()
try:
    # ... work ...
    conn.commit()
finally:
    conn.close()
```

### 3. No Duplicate Detection -- Re-processing Will Insert Duplicate Rows

**Severity: Critical**
**File:** `pipeline.py`, lines 28-34

If `os.rename()` fails after the database insert (e.g., archive dir missing, permission error), the file remains in the input directory and will be fully re-inserted on the next 15-minute cycle, creating duplicate records. There is also no idempotency key or UPSERT logic.

**Recommendation:** Either:
- Add a unique constraint on the transactions table and use `INSERT ... ON CONFLICT DO NOTHING`.
- Track processed filenames in a separate table or file to skip already-processed files.
- Move/rename the file *before* inserting (riskier, but prevents duplicates).

### 4. Credentials in `.env` File

**Severity: Critical**
**File:** `.env`

The `.env` file contains a plaintext database password (`password123`) and a Slack webhook URL. If this file is committed to version control, these secrets are exposed. There is no `.gitignore` present in the project.

**Recommendation:**
- Add a `.gitignore` that excludes `.env`.
- Use a secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault) for production.
- Change the database password from `password123` immediately -- it is trivially guessable.

---

## High-Severity Issues

### 5. No Logging -- Only `print()` Statements

**Severity: High**
**File:** `pipeline.py`, lines 55, 62

Using `print()` instead of Python's `logging` module means:
- No log levels (debug, info, warning, error).
- No timestamps in a consistent format.
- No log rotation or persistence.
- Logs may be lost if stdout is not captured by a process manager.

**Recommendation:** Replace `print()` with `logging` using at minimum an INFO level and a file handler with rotation.

### 6. No Transaction Rollback on Partial Failure

**Severity: High**
**File:** `pipeline.py`, lines 28-36

If the insert loop fails partway through a CSV (e.g., row 500 of 1000 has bad data), rows 1-499 are already staged in the transaction. The code calls `conn.commit()` only after the loop, so a mid-loop exception means no commit happens -- but also no explicit rollback. The connection is leaked in a dirty state.

If the error *doesn't* crash (e.g., a future try/except is added), the partial transaction could be accidentally committed later.

**Recommendation:** Add explicit `conn.rollback()` in the error path. Consider batch inserts with `executemany()` or `copy_expert()` for atomicity and performance.

### 7. Row-by-Row Inserts Are Extremely Slow

**Severity: High**
**File:** `pipeline.py`, lines 28-34

`iterrows()` with individual `INSERT` statements is the slowest possible way to load data into PostgreSQL. For large CSVs (100k+ rows), this will be orders of magnitude slower than bulk methods.

**Recommendation:** Use one of:
- `psycopg2.extras.execute_batch()` or `execute_values()` (10-100x faster).
- `COPY` via `copy_expert()` (fastest).
- `sqlalchemy` + `df.to_sql()` with `method='multi'`.

---

## Medium-Severity Issues

### 8. Reports Directory May Not Exist

**Severity: Medium**
**File:** `pipeline.py`, line 81

The report is saved to `./reports/daily_YYYYMMDD.csv` but there is no code to create this directory. The first run will fail with `FileNotFoundError`.

**Recommendation:** Add `os.makedirs('./reports', exist_ok=True)` before writing the report.

### 9. Relative Paths Will Break Depending on Working Directory

**Severity: Medium**
**Files:** `.env` (lines 2-3), `pipeline.py` (line 81)

`CSV_INPUT_DIR=./data/incoming`, `CSV_ARCHIVE_DIR=./data/processed`, and the report path `./reports/` are all relative. If the script is launched from a different working directory (common with cron, systemd, or Docker), these paths will resolve to the wrong location.

**Recommendation:** Use absolute paths in configuration, or resolve them relative to the script's directory:
```python
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
```

### 10. No File Locking -- Race Condition With External Writers

**Severity: Medium**
**File:** `pipeline.py`, line 18

If an external process is still writing a CSV when the pipeline picks it up (via `glob.glob`), `pd.read_csv()` will read a partial/corrupt file.

**Recommendation:** Use a staging pattern: external writers write to a `.tmp` file and rename to `.csv` atomically when done. Or check file modification time and skip files modified within the last N seconds.

### 11. `schedule` Library Is Not Production-Grade

**Severity: Medium**
**File:** `pipeline.py`, lines 89-97

The `schedule` library runs in a single thread with a `time.sleep(60)` polling loop. Problems:
- If `run_pipeline()` takes longer than 15 minutes, jobs will back up and run consecutively.
- A crash in the while loop kills the entire scheduler with no restart.
- No concurrency control.

**Recommendation:** For production, use `cron`, `systemd` timers, `APScheduler`, or Celery Beat. At minimum, run under a process supervisor like `supervisord` or `systemd` that will restart on crash.

### 12. Slack Notification Failure Blocks/Crashes the Pipeline

**Severity: Medium**
**File:** `pipeline.py`, lines 58-60, 84-86

`requests.post()` to Slack has no timeout. If the Slack API is slow or down, the call will hang indefinitely (default `requests` timeout is `None`). If it returns an HTTP error, it's silently ignored (no status check), but a connection error will raise an exception and crash the pipeline.

**Recommendation:** Add `timeout=10`, wrap in try/except, and don't let notification failures affect data processing.

### 13. No Data Validation Beyond Type Casting

**Severity: Medium**
**File:** `pipeline.py`, lines 21-23

The only "cleaning" is type-casting `amount` to float, parsing `date`, and stripping whitespace from `customer_name`. There is no validation for:
- Negative or zero amounts.
- Future dates or dates far in the past.
- NULL/NaN values in required fields.
- Unexpected categories or regions.
- String length limits that match the database schema.

**Recommendation:** Add validation rules and either reject or flag bad rows rather than inserting them blindly.

---

## Low-Severity Issues

### 14. Requirements Are Not Pinned

**Severity: Low**
**File:** `requirements.txt`

No version pins means `pip install -r requirements.txt` could install breaking changes in any dependency at any time.

**Recommendation:** Pin versions, e.g., `pandas==2.2.0`. Use `pip freeze` to capture current working versions.

### 15. Daily Report Query Uses `CURRENT_DATE` With No Timezone Awareness

**Severity: Low**
**File:** `pipeline.py`, lines 68-76

`CURRENT_DATE` uses the PostgreSQL server's timezone setting. If the server timezone differs from the business timezone, the report will cover the wrong 24-hour window.

**Recommendation:** Use explicit timezone-aware boundaries, e.g., `WHERE date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date`.

### 16. No Health Check or Monitoring Endpoint

**Severity: Low**
**File:** `pipeline.py`

There is no way to tell externally if the pipeline is still running, stuck, or healthy. If the `while True` loop hangs, nothing will alert.

**Recommendation:** Add a heartbeat mechanism -- e.g., write a timestamp to a file or expose a simple HTTP health endpoint. Pair with an external monitor.

### 17. Archive Filename Collisions

**Severity: Low**
**File:** `pipeline.py`, lines 41-42

If two input files have the same basename (e.g., from different subdirectories, or a file reappears), `os.rename()` will overwrite the previously archived file without warning.

**Recommendation:** Append a timestamp or UUID to the archived filename.

---

## Summary Table

| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1 | No error handling anywhere | Critical | Reliability |
| 2 | DB connections leaked on error | Critical | Resource Leak |
| 3 | No duplicate detection | Critical | Data Integrity |
| 4 | Credentials in `.env`, no `.gitignore` | Critical | Security |
| 5 | No logging (only `print`) | High | Observability |
| 6 | No transaction rollback on partial failure | High | Data Integrity |
| 7 | Row-by-row inserts are extremely slow | High | Performance |
| 8 | Reports directory may not exist | Medium | Reliability |
| 9 | Relative paths break with different CWD | Medium | Reliability |
| 10 | No file locking / race with writers | Medium | Data Integrity |
| 11 | `schedule` library not production-grade | Medium | Reliability |
| 12 | Slack calls have no timeout, can crash pipeline | Medium | Reliability |
| 13 | No data validation beyond type casting | Medium | Data Quality |
| 14 | Requirements not pinned | Low | Reproducibility |
| 15 | Report query has no timezone awareness | Low | Correctness |
| 16 | No health check or monitoring | Low | Observability |
| 17 | Archive filename collisions | Low | Data Integrity |

---

## Top Recommendations Before Running in Production

1. **Add error handling** with try/except around every I/O operation (file reads, DB queries, HTTP calls). Use `finally` to close connections.
2. **Add logging** with Python's `logging` module, including file-based log rotation.
3. **Implement duplicate prevention** via database constraints (UPSERT) or processed-file tracking.
4. **Secure credentials** -- add `.gitignore`, use a secrets manager, change the default password.
5. **Use bulk inserts** (`execute_values` or `COPY`) instead of row-by-row iteration.
6. **Create required directories** (`reports/`, `data/incoming/`, `data/processed/`) at startup.
7. **Use absolute paths** or resolve relative to the script directory.
8. **Run under a process supervisor** (systemd, supervisord) instead of bare `python pipeline.py`.
9. **Pin dependency versions** in `requirements.txt`.
10. **Add a timeout** to all `requests.post()` calls.
