# Edge Case Audit Report: Python Data Pipeline

## What's solid

- **Parameterized SQL queries** -- you're using `%s` placeholders with `psycopg2`, not f-strings, so SQL injection is not a concern here.
- **Clean separation of concerns** -- `process_csv`, `run_pipeline`, and `generate_daily_report` each do one job, making the codebase straightforward to extend.
- **Archive-after-process pattern** -- moving CSVs out of the input directory after insertion prevents naive re-processing on the happy path.
- **Slack notifications on completion** -- gives you visibility into pipeline runs without needing to SSH in and tail logs.

---

## Critical

### 1. No error handling anywhere -- a single bad row kills the entire pipeline run

If any CSV has a malformed `amount`, a missing `date`, or an unexpected column name, `process_csv` throws an unhandled exception. The `for filepath in csv_files` loop in `run_pipeline` aborts mid-way. Files already processed are archived, files not yet reached are silently skipped, and the Slack notification never fires. The scheduler keeps running, but the remaining files sit untouched until the next cycle -- where the same bad file crashes it again.

**Fix pattern:**
```python
def run_pipeline():
    input_dir = os.getenv('CSV_INPUT_DIR')
    csv_files = glob.glob(os.path.join(input_dir, '*.csv'))
    total_records = 0
    errors = []
    for filepath in csv_files:
        try:
            count = process_csv(filepath)
            total_records += count
        except Exception as e:
            errors.append((filepath, str(e)))
            logging.exception(f"Failed to process {filepath}")
    # Always send notification, including error summary
    msg = f"Pipeline complete: {total_records} records from {len(csv_files) - len(errors)} files"
    if errors:
        msg += f"\n:warning: {len(errors)} file(s) failed: {', '.join(os.path.basename(f) for f, _ in errors)}"
    requests.post(os.getenv('SLACK_WEBHOOK_URL'), json={'text': msg})
```

### 2. DB connection leaks on any exception

`get_db_connection()` returns a raw connection. If anything between `conn = get_db_connection()` and `conn.close()` raises (bad data, network blip, disk full on archive), the connection is never closed. After enough failures, you exhaust the Postgres connection pool and the pipeline -- plus anything else hitting that database -- goes down.

**Fix pattern:**
```python
def process_csv(filepath):
    df = pd.read_csv(filepath)
    # ... cleaning ...
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            # ... inserts ...
        conn.commit()
    # archive after DB work succeeds
```
Note: `psycopg2` connections as context managers handle rollback on exception but do **not** call `close()`. Wrap in a try/finally or use a connection pool (`psycopg2.pool`).

### 3. No idempotency -- re-running on the same data creates duplicate rows

If the process crashes after `conn.commit()` but before `os.rename()` (archive), the next scheduler cycle re-reads the same CSV and inserts every row again. There is no unique constraint, no upsert, and no deduplication check. Over time this silently corrupts aggregates in the daily report.

**Fix pattern:** Add a unique constraint on the natural key (e.g., `customer_name + date + amount + category + region`) and switch to `INSERT ... ON CONFLICT DO NOTHING`, or add a file-level tracking table that records which filenames have been fully ingested.

### 4. Plaintext credentials in `.env` with no `.gitignore`

`DATABASE_URL` contains `admin:password123` in cleartext. There is no `.gitignore` shown, so `.env` will be committed if this is a git repo. Anyone with read access to the repo gets full database credentials and the Slack webhook URL.

**Fix pattern:** Add a `.gitignore` with `.env` in it immediately. For production, use a secrets manager (AWS SSM, Vault, etc.) or inject env vars through your deployment tooling rather than a dotenv file on disk.

---

## High

### 5. Row-by-row inserts -- will not scale

`df.iterrows()` with individual `INSERT` statements means one round-trip per row. A 100K-row CSV will take minutes. At 15-minute intervals, the pipeline can fall behind and jobs start overlapping (see #7).

**Fix pattern:**
```python
from psycopg2.extras import execute_values
execute_values(cur,
    "INSERT INTO transactions (customer_name, amount, date, category, region) VALUES %s",
    [tuple(row) for row in df[['customer_name','amount','date','category','region']].values],
    page_size=1000)
```

### 6. No data validation before insert

`df['amount'].astype(float)` will raise on non-numeric values, but there is no check for nulls in required columns, negative amounts, dates in the future, or unexpected category/region values. Bad data that passes the type cast goes straight into the database.

**Fix pattern:** Validate before inserting -- drop or quarantine rows that fail checks:
```python
df = df.dropna(subset=['customer_name', 'amount', 'date', 'category', 'region'])
assert (df['amount'] >= 0).all(), "Negative amounts detected"
```

### 7. No overlap protection on scheduled jobs

If `run_pipeline` takes longer than 15 minutes (large files, slow network, DB contention), `schedule` fires a second instance while the first is still running. Two processes read the same CSV directory, both try to insert the same files, and `os.rename` on the second will fail or -- worse -- both succeed and you get double inserts.

**Fix pattern:** Use a file lock or a simple boolean guard:
```python
import threading
pipeline_lock = threading.Lock()

def run_pipeline():
    if not pipeline_lock.acquire(blocking=False):
        print("Pipeline already running, skipping this cycle")
        return
    try:
        # ... existing logic ...
    finally:
        pipeline_lock.release()
```

### 8. Report and archive directories are never created

`./reports/` is used in `generate_daily_report` and `CSV_ARCHIVE_DIR` is `./data/processed`. Neither is created by the code. On a fresh server deployment, both `os.rename` and `df.to_csv` will raise `FileNotFoundError` on the first run.

**Fix pattern:** Add `os.makedirs(path, exist_ok=True)` at startup for both directories.

### 9. Dependency versions not pinned

`requirements.txt` lists bare package names with no versions. A future `pip install` could pull a breaking pandas 3.x or psycopg2 change and silently alter behavior.

**Fix pattern:** Pin to exact versions: `pandas==2.2.1`, `psycopg2-binary==2.9.9`, etc. Use `pip freeze` to capture current working versions.

### 10. Timezone not set for scheduler

`schedule.every().day.at("08:00")` uses the system's local timezone. If deployed to a cloud server in UTC, the daily report fires at 08:00 UTC, not your business timezone. If the server's timezone changes (e.g., DST, container redeployment), the report shifts.

**Fix pattern:** Set `TZ` explicitly in your environment or container, or use a timezone-aware scheduler like APScheduler.

---

## Worth noting

- **Large CSVs loaded entirely into memory** -- `pd.read_csv(filepath)` on a multi-GB file will OOM. If your CSVs stay under ~500MB this is fine; if they might grow, use `chunksize` parameter.
- **No graceful shutdown** -- `Ctrl+C` or `SIGTERM` during a `process_csv` call leaves a partial commit in the DB and the file un-archived. A signal handler that sets a "stop after current file" flag would prevent this.
- **Slack webhook failure crashes the pipeline** -- if the Slack POST fails (network issue, expired webhook), the unhandled exception propagates. This is a sub-case of the "no error handling" critical issue but worth noting that even a successful data run can appear to fail.

---

## Risk Summary

| # | Issue | Severity | Likelihood | Impact |
|---|-------|----------|------------|--------|
| 1 | No error handling -- one bad file halts everything | Critical | High | Full pipeline stall |
| 2 | DB connection leak on exceptions | Critical | Medium | Postgres connection exhaustion |
| 3 | No idempotency -- duplicates on re-run | Critical | High | Silent data corruption |
| 4 | Plaintext credentials, no .gitignore | Critical | High | Credential exposure |
| 5 | Row-by-row inserts | High | Medium | Pipeline falls behind schedule |
| 6 | No data validation | High | Medium | Bad data in production DB |
| 7 | No overlap protection | High | Medium | Duplicate inserts, rename errors |
| 8 | Report/archive dirs not created | High | High (first deploy) | Crash on first run |
| 9 | Unpinned dependencies | High | Medium | Silent breakage on redeploy |
| 10 | Timezone not set | High | Medium | Report fires at wrong hour |

---

## Deployment Checklist (Critical + High)

- [ ] Wrap `process_csv` calls in try/except; always send Slack summary including failures
- [ ] Use context managers (`with`) for all DB connections and cursors; add try/finally for `close()`
- [ ] Add idempotency: unique constraint + `ON CONFLICT DO NOTHING`, or file-tracking table
- [ ] Add `.gitignore` with `.env`; rotate the exposed `password123` credential immediately
- [ ] Replace `iterrows` + single inserts with `execute_values` or `COPY`
- [ ] Validate required columns, types, and value ranges before inserting
- [ ] Add a lock or guard to prevent overlapping pipeline runs
- [ ] Add `os.makedirs(..., exist_ok=True)` for `reports/` and `CSV_ARCHIVE_DIR` at startup
- [ ] Pin all dependency versions in `requirements.txt`
- [ ] Set `TZ` environment variable or use timezone-aware scheduling

---

## Verdict

**Do not deploy as-is.** The pipeline will work on the first sunny-day run, but the first malformed CSV, network hiccup, or process restart will cause silent data duplication, connection leaks, or a full stall with no notification. The credential exposure in `.env` is an immediate security concern if this repo is shared or pushed anywhere.

The core design is sound -- the fixes above are targeted, not a rewrite.

## Suggested next action

Start with the deployment checklist items 1-4 (error handling, connection management, idempotency, credentials). These address all four critical issues and can be done in a single focused session. Then tackle the high-severity items before your first production run.

**Want me to refactor `process_csv` with context managers, try/except, and batch inserts as a drop-in replacement?**
