## Edge Case Audit — Python Data Pipeline (CSV-to-Postgres) — Pre-Deployment

**What I reviewed:** `pipeline.py`, `requirements.txt`, `.env`
**Build health:** Critical Issues

---

### What's solid
> - Parameterized SQL queries — no SQL injection risk from the `cur.execute` with `%s` placeholders.
> - Clean separation of concerns — `process_csv`, `run_pipeline`, and `generate_daily_report` are well-scoped functions with a clear data flow.
> - Slack notifications on completion give basic operational visibility.
> - Archive-after-process pattern is a reasonable approach to avoiding reprocessing.

---

### Critical — Will break in production

**No idempotency — re-runs and retries create duplicate rows**
- **Where:** `pipeline.py:28-33` — `process_csv()`
- **What happens:** Every row is an unconditional `INSERT`. If the pipeline crashes after inserting 500 of 1000 rows but before the file is archived, the next run re-processes the same file and inserts all 1000 rows again — 500 of which are duplicates. There is no dedup key, no `ON CONFLICT` clause, and no transaction-level tracking of which files have been fully ingested.
- **Fix:** Add a unique constraint on your transactions table (e.g., on `customer_name, amount, date, category, region` or better, a source row ID) and use `INSERT ... ON CONFLICT DO NOTHING`. Alternatively, track processed filenames in a `pipeline_runs` table and skip files already recorded there.

```python
cur.execute(
    """INSERT INTO transactions (customer_name, amount, date, category, region)
       VALUES (%s, %s, %s, %s, %s)
       ON CONFLICT (customer_name, date, amount, category, region) DO NOTHING""",
    (row['customer_name'], row['amount'], row['date'],
     row['category'], row['region'])
)
```

**No error handling — one bad CSV kills the entire pipeline**
- **Where:** `pipeline.py:18-43` — `process_csv()` and `pipeline.py:46-58` — `run_pipeline()`
- **What happens:** If any CSV has a missing `amount` column, a malformed date, or a null `customer_name`, the `astype(float)` / `pd.to_datetime` / `str.strip()` call throws an unhandled exception. The database connection is never closed (connection leak), the Slack summary is never sent, and remaining CSVs in the batch are skipped. Because the file was not archived, the broken file blocks all future runs too.
- **Fix:** Wrap `process_csv` in a try/except inside the loop. Use `finally` or a context manager to guarantee the connection closes. Log and skip bad files.

```python
for filepath in csv_files:
    try:
        count = process_csv(filepath)
        total_records += count
    except Exception as e:
        logging.error(f"Failed to process {filepath}: {e}")
        # Move to a dead-letter directory instead of blocking future runs
        shutil.move(filepath, os.path.join(dead_letter_dir, os.path.basename(filepath)))
```

**Database connection never closed on error — connection leak**
- **Where:** `pipeline.py:25-37` — `process_csv()`
- **What happens:** If any exception occurs between `get_db_connection()` and `conn.close()` (e.g., a bad row, a network blip), the connection object is leaked. With the pipeline running every 15 minutes and no connection pooling, leaked connections accumulate until Postgres hits `max_connections` and the entire pipeline (and anything else using that database) stops working.
- **Fix:** Use a context manager or try/finally.

```python
conn = get_db_connection()
try:
    cur = conn.cursor()
    # ... inserts ...
    conn.commit()
finally:
    conn.close()
```

**Credentials in `.env` with a real password**
- **Where:** `.env:1`
- **What happens:** `DATABASE_URL=postgresql://admin:password123@db.example.com:5432/analytics` contains a plaintext password. If `.env` is committed to version control (no `.gitignore` was provided), your database credentials are exposed to anyone with repo access.
- **Fix:** Confirm `.env` is in `.gitignore`. Rotate the password `password123` immediately — it may already be in git history. For production, use environment variables injected by your deployment platform or a secrets manager, not a dotenv file on disk.

---

### High — Will bite you under realistic conditions

**No concurrency guard — overlapping pipeline runs**
- **Where:** `pipeline.py:93-97` — scheduler loop
- **What happens:** If a pipeline run takes longer than 15 minutes (large batch of CSVs, slow DB), the scheduler fires a second run while the first is still going. Both runs pick up the same CSV files from `glob.glob`, process them in parallel, and insert duplicate rows. The second run's `os.rename` to archive will then fail because the first run already moved the file, causing an unhandled `FileNotFoundError`.
- **Fix:** Use a file lock or a simple boolean guard.

```python
import fcntl

LOCK_FILE = '/tmp/pipeline.lock'

def run_pipeline():
    lock_fd = open(LOCK_FILE, 'w')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("Pipeline already running, skipping this cycle")
        return
    try:
        # ... existing pipeline logic ...
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()
```

**Row-by-row inserts — will OOM or crawl on large files**
- **Where:** `pipeline.py:28-33` — `process_csv()`
- **What happens:** `pd.read_csv(filepath)` loads the entire file into memory. A 2GB CSV will consume 4-6GB of RAM in pandas. Then `df.iterrows()` issues one INSERT per row — a 1M-row file means 1M round-trips to Postgres. This is both a memory bomb and a performance cliff.
- **Fix:** Use chunked reading and batch inserts.

```python
from psycopg2.extras import execute_values

for chunk in pd.read_csv(filepath, chunksize=5000):
    # clean chunk...
    values = [tuple(row) for row in chunk[['customer_name','amount','date','category','region']].values]
    execute_values(cur,
        "INSERT INTO transactions (customer_name, amount, date, category, region) VALUES %s",
        values)
    conn.commit()
```

**No data validation — garbage in, garbage persisted**
- **Where:** `pipeline.py:21-23` — `process_csv()`
- **What happens:** Negative amounts, future dates (year 2099), empty customer names (after strip), and missing columns all pass through unchecked and get written to Postgres. The daily report then produces nonsensical totals.
- **Fix:** Add validation after cleaning.

```python
assert set(['amount','date','customer_name','category','region']).issubset(df.columns), "Missing required columns"
df = df.dropna(subset=['customer_name', 'amount', 'date'])
df = df[df['amount'] > 0]
df = df[df['date'] <= pd.Timestamp.now()]
```

**Dependency versions not pinned**
- **Where:** `requirements.txt`
- **What happens:** `pandas` without a version pin means a `pip install` today gets pandas 2.x, but six months from now it might get pandas 3.x with breaking API changes. Your production deploy becomes non-reproducible.
- **Fix:** Pin exact versions.

```
pandas==2.2.1
psycopg2-binary==2.9.9
python-dotenv==1.0.1
schedule==1.2.1
requests==2.31.0
```

**Archive/report directories may not exist**
- **Where:** `pipeline.py:40` — `os.rename(...)` and `pipeline.py:71` — `df.to_csv(report_path, ...)`
- **What happens:** If `CSV_ARCHIVE_DIR` (`./data/processed`) or `./reports/` doesn't exist on the server, `os.rename` raises `FileNotFoundError` and `to_csv` raises `FileNotFoundError`. This happens after the data is already committed to Postgres, so you get inserted data with no archive — and the file gets reprocessed next cycle (duplicates again).
- **Fix:** `os.makedirs(dir, exist_ok=True)` at startup or before each write.

---

### Worth noting — Low risk but worth a look

**No graceful shutdown**
- **Where:** `pipeline.py:95-97` — `while True` loop
- **What happens:** Sending SIGTERM (e.g., `docker stop`, `systemctl stop`) during an active `process_csv` call kills the process mid-transaction. The uncommitted rows are rolled back by Postgres (no data corruption), but the file remains in the input directory and will be fully reprocessed — creating duplicates of any rows committed in a prior partial run if you lack idempotency.
- **Fix:** Register a signal handler that sets a shutdown flag checked between files.

**Slack notification failure is silent**
- **Where:** `pipeline.py:54-56` — `requests.post(...)`
- **What happens:** If the Slack webhook is down or the URL is misconfigured, `requests.post` throws an exception after the pipeline has already completed successfully — and since there's no try/except, the exception propagates up and looks like a pipeline failure.
- **Fix:** Wrap Slack calls in try/except and log the failure without crashing.

**Timezone not set for scheduler or date queries**
- **Where:** `pipeline.py:63` — `WHERE date >= CURRENT_DATE - INTERVAL '1 day'`
- **What happens:** `CURRENT_DATE` uses the Postgres server's timezone. `schedule.every().day.at("08:00")` uses the Python process's local timezone. If these differ (common with cloud-hosted Postgres), the daily report either misses transactions or double-counts them at the boundary. DST shifts can also move the report time by an hour.
- **Fix:** Set `timezone` explicitly in the Postgres connection and use `datetime.now(timezone.utc)` in Python.

---

### Risk Summary
| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1 | No idempotency — duplicates on re-run | Critical | Pipeline Resilience |
| 2 | No error handling — one bad file kills pipeline | Critical | Pipeline Resilience |
| 3 | Connection leak on error | Critical | Resource Management |
| 4 | Plaintext credentials in `.env` | Critical | Secrets & Credentials |
| 5 | No concurrency guard — overlapping runs | High | Scheduling & Timing |
| 6 | Row-by-row inserts / full file in memory | High | Data Integrity / Performance |
| 7 | No data validation | High | Data Integrity |
| 8 | Dependency versions not pinned | High | Deployment & Environment |
| 9 | Archive/report directories may not exist | High | File & Storage Operations |
| 10 | No graceful shutdown | Worth noting | Pipeline Resilience |
| 11 | Slack failure crashes pipeline | Worth noting | Pipeline Resilience |
| 12 | Timezone mismatch in scheduler vs DB | Worth noting | Scheduling & Timing |

### Deployment Checklist
- [ ] Add `ON CONFLICT` or dedup mechanism to INSERT statements
- [ ] Wrap `process_csv` in try/except; add dead-letter directory for bad files
- [ ] Use context managers (`with`) for all database connections
- [ ] Confirm `.env` is in `.gitignore`; rotate the database password
- [ ] Add file lock to prevent overlapping pipeline runs
- [ ] Switch to chunked reads + batch inserts (`execute_values`)
- [ ] Add column presence checks and value validation after cleaning
- [ ] Pin all dependency versions in `requirements.txt`
- [ ] Add `os.makedirs(..., exist_ok=True)` for archive and report directories

**Verdict:** This pipeline will work on the first happy-path run, but it will produce duplicate data after any interruption or retry, and a single malformed CSV will block all processing indefinitely. It is not safe to deploy without at minimum fixing idempotency, error handling, and connection management.

**Suggested next action:** Add `ON CONFLICT DO NOTHING` to the INSERT and wrap `process_csv` in try/except with a dead-letter directory — those two changes eliminate the two most damaging failure modes.

---

Want me to refactor `process_csv` with connection management, error handling, batch inserts, and idempotent upserts in one pass? That would address issues #1-3 and #6 together.
