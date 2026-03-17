## Edge Case Audit — Automation Pipeline — Pre-Deploy

**What I reviewed:** `pipeline.py`, `requirements.txt`, `.env`
**Build health:** Critical Issues — several issues that will cause failures under normal operating conditions

**Build type:** Automation pipeline (scheduled CSV ingestion + daily reporting)
**Current phase:** Pre-deploy
**Key integrations:** PostgreSQL (psycopg2), Slack webhooks, local filesystem (CSV read/write)
**Risk surface:** CSV files in → Postgres writes out; Slack notifications on each run; daily report written to disk

---

### Critical — Will break in production

**1. No error handling anywhere — a single bad CSV row kills the entire pipeline**
- **Where:** `pipeline.py:16-43` — `process_csv()`
- **What happens:** If any CSV file has a missing `amount`, `date`, or `customer_name` column, or contains a non-numeric `amount` value, the pipeline throws an unhandled exception. The database connection is never closed, the Slack notification is never sent, and all remaining CSV files in the batch are skipped.
- **When it triggers:** The first time a CSV arrives with an unexpected format, a null value, or a malformed row.
- **Fix:** Wrap `process_csv()` in a try/except block, and within the function, validate the DataFrame before processing. Close the connection in a `finally` block or use a context manager:
```python
def process_csv(filepath):
    conn = None
    try:
        df = pd.read_csv(filepath)
        required_cols = {'amount', 'date', 'customer_name', 'category', 'region'}
        if not required_cols.issubset(df.columns):
            raise ValueError(f"Missing columns: {required_cols - set(df.columns)}")
        # ... processing ...
    except Exception as e:
        logging.error(f"Failed to process {filepath}: {e}")
        # don't move to archive — leave it for retry or move to a dead-letter dir
        return 0
    finally:
        if conn:
            conn.close()
```

**2. No duplicate protection — re-running the pipeline inserts duplicate records**
- **Where:** `pipeline.py:28-34` — the `INSERT INTO transactions` loop
- **What happens:** Every row is inserted unconditionally. If the pipeline crashes after inserting half a file but before archiving it, the next run re-processes the same file and inserts duplicate rows. There is also no way to recover from a partial failure.
- **When it triggers:** Any crash, restart, or re-run of the pipeline against the same CSV file.
- **Fix:** Either use `INSERT ... ON CONFLICT DO NOTHING` with a unique constraint (e.g., on `customer_name + date + amount`), or track processed filenames in a database table and skip already-seen files.

**3. Database connection leaked on any exception**
- **Where:** `pipeline.py:25-38` — `process_csv()`
- **What happens:** `conn.close()` is only reached on the happy path. If `df['amount'].astype(float)` throws, or the INSERT fails, or `os.rename` fails, the connection is never closed. Over time, this exhausts the Postgres connection pool and locks out the pipeline entirely.
- **When it triggers:** Any error during CSV processing or file archiving.
- **Fix:** Use a `with` block or `try/finally`:
```python
conn = get_db_connection()
try:
    cur = conn.cursor()
    # ... inserts ...
    conn.commit()
finally:
    conn.close()
```

**4. Slack webhook failure kills the pipeline**
- **Where:** `pipeline.py:58-60` — `requests.post()` in `run_pipeline()`
- **What happens:** If the Slack webhook URL is invalid, Slack is down, or there's a network issue, `requests.post()` raises an exception. This happens *after* all CSVs have been processed, so the work is done but the pipeline appears to fail. The `schedule` loop may stop if the exception propagates.
- **When it triggers:** Any Slack outage or network blip.
- **Fix:** Wrap the Slack notification in a try/except and treat it as non-critical:
```python
try:
    requests.post(os.getenv('SLACK_WEBHOOK_URL'), json={...}, timeout=10)
except Exception as e:
    logging.warning(f"Slack notification failed: {e}")
```

---

### High — Will bite you under realistic conditions

**5. No overlap protection on the 15-minute scheduled job**
- **Where:** `pipeline.py:89` — `schedule.every(15).minutes.do(run_pipeline)`
- **What happens:** If `run_pipeline()` takes longer than 15 minutes (large batch of CSVs, slow DB), the `schedule` library will fire the next run while the previous one is still executing. Since there's no lock, two runs process the same files concurrently, causing duplicate inserts and race conditions on `os.rename`.
- **When it triggers:** When a large batch of CSVs accumulates (e.g., after a downtime recovery) or the database is slow.
- **Fix:** Add a simple lock:
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

**6. `os.rename` fails across filesystems and race-conditions with the archiver**
- **Where:** `pipeline.py:41-42` — `os.rename(filepath, archive_path)`
- **What happens:** `os.rename()` does not work across filesystem boundaries (e.g., if `CSV_INPUT_DIR` and `CSV_ARCHIVE_DIR` are on different mount points). It also runs *after* `conn.close()` — if the rename fails, the file stays in the input directory and will be re-processed and duplicated on the next run.
- **When it triggers:** When archive directory is on a different volume, or if the archive directory doesn't exist.
- **Fix:** Use `shutil.move()` instead of `os.rename()`, and ensure the archive directory exists at startup. Move the file archiving into the success path after the commit:
```python
import shutil
os.makedirs(os.getenv('CSV_ARCHIVE_DIR'), exist_ok=True)
shutil.move(filepath, archive_path)
```

**7. Daily report directory assumed to exist**
- **Where:** `pipeline.py:81` — `df.to_csv(report_path, index=False)`
- **What happens:** The report writes to `./reports/daily_YYYYMMDD.csv`. If the `./reports/` directory does not exist, this throws a `FileNotFoundError` and the daily report silently fails.
- **When it triggers:** First run on a fresh deployment.
- **Fix:** Add `os.makedirs('./reports', exist_ok=True)` before writing.

**8. Credentials in `.env` with no `.gitignore` protection**
- **Where:** `.env:1` — `DATABASE_URL=postgresql://admin:password123@db.example.com:5432/analytics`
- **What happens:** The `.env` file contains plaintext database credentials and a Slack webhook URL. There is no `.env.example` file documenting required variables, and no `.gitignore` was found, so this file may be committed to version control.
- **When it triggers:** When the repo is shared, pushed to a remote, or accessed by anyone with repo access.
- **Fix:** Add a `.gitignore` with `.env`, create a `.env.example` with placeholder values, and rotate the exposed credentials.

---

### Worth noting — Low risk but worth a look

**9. Dependency versions not pinned**
- **Where:** `requirements.txt`
- **What happens:** All dependencies are listed without version pins (`pandas`, not `pandas==2.1.4`). A future `pip install` could pull a breaking change.
- **Fix:** Pin versions with `pip freeze > requirements.txt` or specify minimum versions.

**10. No logging — only print statements**
- **Where:** `pipeline.py:55,62` — `print()` calls
- **What happens:** On a server, print output may not be captured or may be lost. No structured logging means no searchable history of pipeline runs.
- **Fix:** Replace `print()` with Python's `logging` module configured to write to a file or stdout with timestamps.

**11. No request timeout on Slack posts**
- **Where:** `pipeline.py:58,84` — `requests.post()`
- **What happens:** `requests.post()` with no `timeout` parameter can hang indefinitely if Slack is unreachable, blocking the entire scheduler loop.
- **Fix:** Add `timeout=10` to all `requests.post()` calls.

---

**Verdict:** This pipeline will break on its first encounter with a malformed CSV or any transient error. The lack of error handling, connection management, and idempotency are showstoppers that need to be addressed before running this on a server.

**Suggested next action:** Add try/except error handling and connection cleanup in `process_csv()` first — this is the highest-impact fix and prevents the pipeline from going silent after the first bad file.

---

> Want me to fix any of these? Or should I run a deeper audit on a specific area?
