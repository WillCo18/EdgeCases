## Edge Case Audit — Automation Pipeline — Pre-Deploy

**What I reviewed:** `pipeline.py`, `requirements.txt`, `.env`
**Build health:** Critical Issues — several near-certain production failures

- **Build type:** Automation pipeline (scheduled data ingestion + daily reporting)
- **Current phase:** Pre-deploy
- **Key integrations:** PostgreSQL (psycopg2), Slack (webhook), local filesystem (CSV read/write), schedule library
- **Risk surface:** CSV files enter the system from `CSV_INPUT_DIR`, are inserted into Postgres, and reports are written to `./reports/`. Notifications exit via Slack webhook.

---

### Critical — Will break in production

**1. No error handling anywhere — a single bad CSV kills the entire pipeline**
- **Where:** `pipeline.py:16–44` — `process_csv()`
- **What happens:** If any CSV has a missing `amount`, `date`, or `customer_name` column, or contains a value that can't be cast to float/datetime, the function throws an unhandled exception. The DB connection is never closed (connection leak), the file is never archived, and `run_pipeline()` aborts — no remaining CSVs are processed. The Slack notification on line 58 is never sent, so the failure is completely silent.
- **When it triggers:** First time a CSV arrives with a missing column, a non-numeric amount, an unparseable date, or a null customer_name.
- **Fix:** Wrap `process_csv()` in try/except with proper cleanup. Use a `finally` block or context manager for the DB connection. Log and continue on per-file failures so one bad file doesn't block the rest:
  ```python
  def run_pipeline():
      input_dir = os.getenv('CSV_INPUT_DIR')
      csv_files = glob.glob(os.path.join(input_dir, '*.csv'))
      total_records = 0
      failed_files = []
      for filepath in csv_files:
          try:
              count = process_csv(filepath)
              total_records += count
          except Exception as e:
              failed_files.append((filepath, str(e)))
              logging.error(f"Failed to process {filepath}: {e}")
      # Send summary including failures
  ```

**2. Database connection leak on any error**
- **Where:** `pipeline.py:25–38` — `process_csv()`
- **What happens:** `conn` is opened on line 25 but `conn.close()` on line 38 is only reached on the happy path. Any exception during iteration, insert, or commit leaves the connection open. Over time (especially with recurring 15-minute runs hitting bad files), the Postgres connection pool is exhausted and the entire pipeline stops working.
- **When it triggers:** Any error after `get_db_connection()` is called — bad data, network blip, disk full, etc.
- **Fix:** Use a context manager or try/finally:
  ```python
  conn = get_db_connection()
  try:
      cur = conn.cursor()
      for _, row in df.iterrows():
          cur.execute(...)
      conn.commit()
  except Exception:
      conn.rollback()
      raise
  finally:
      conn.close()
  ```

**3. No idempotency — re-running or overlapping executions create duplicate records**
- **Where:** `pipeline.py:29–34` — `INSERT INTO transactions`
- **What happens:** Every run does a plain `INSERT`. If the pipeline crashes after inserting some rows but before archiving the file (line 42), the next run re-processes the same CSV and inserts all records again. There is no deduplication key, no `ON CONFLICT` clause, and no tracking of which files have been partially processed.
- **When it triggers:** Any crash or restart between the commit on line 36 and the file move on line 42. Also triggers if two pipeline runs overlap (see issue #5).
- **Fix:** Add a unique constraint on a natural key (e.g., `customer_name, amount, date`) and use `INSERT ... ON CONFLICT DO NOTHING`, or track processed files in a database table with their checksums before processing.

**4. Committed `.env` file with production credentials in plain text**
- **Where:** `.env:1` — `DATABASE_URL=postgresql://admin:password123@db.example.com:5432/analytics`
- **What happens:** The `.env` file contains a database password (`password123`) and a Slack webhook URL. There is no `.gitignore` file in the project, so these will be (or already are) committed to version control.
- **When it triggers:** Immediately — anyone with repo access can see the database credentials and Slack webhook.
- **Fix:** Add a `.gitignore` that excludes `.env`. Rotate the database password and Slack webhook. Create a `.env.example` with placeholder values. If already committed, scrub from git history.

**5. No overlap protection — 15-minute jobs can run concurrently**
- **Where:** `pipeline.py:89` — `schedule.every(15).minutes.do(run_pipeline)`
- **What happens:** If `run_pipeline()` takes longer than 15 minutes (large batch of CSVs, slow DB, network issues), the `schedule` library will fire the next run while the previous one is still executing. Since there is no file locking or mutex, both runs will pick up the same CSV files from the input directory, process them concurrently, insert duplicate records, and then both try to `os.rename()` the same file — one of which will fail with a `FileNotFoundError`.
- **When it triggers:** When CSV processing takes longer than the 15-minute interval, or when a backlog accumulates.
- **Fix:** Add a simple lock:
  ```python
  import threading
  pipeline_lock = threading.Lock()

  def run_pipeline():
      if not pipeline_lock.acquire(blocking=False):
          print("Previous run still in progress, skipping")
          return
      try:
          # ... existing logic ...
      finally:
          pipeline_lock.release()
  ```

**6. Partial commit then failed archive leaves inconsistent state**
- **Where:** `pipeline.py:36–42` — `conn.commit()` then `os.rename()`
- **What happens:** Records are committed to the database on line 36, then the file is moved on line 42. If `os.rename()` fails (archive directory doesn't exist, permission error, cross-device move), the data is in Postgres but the file stays in the input directory. The next run re-inserts everything. There is no check that the archive directory exists.
- **When it triggers:** When `CSV_ARCHIVE_DIR` doesn't exist, is on a different filesystem, or has incorrect permissions.
- **Fix:** Verify the archive directory exists at startup. Use `shutil.move()` instead of `os.rename()` (which fails across filesystems). Better yet, move the file _before_ processing and track state in the DB.

---

### High — Will bite you under realistic conditions

**7. No data validation — garbage CSV data is persisted to Postgres**
- **Where:** `pipeline.py:18–23` — `process_csv()` data cleaning
- **What happens:** The "cleaning" assumes all expected columns exist and contain castable values. There is no validation that `amount` is positive, `date` is within a reasonable range, `customer_name` is non-empty after stripping, or that `category` and `region` are valid values. Negative amounts, dates from the year 3000, and empty customer names will all be persisted.
- **When it triggers:** First malformed or adversarial CSV.
- **Fix:** Add validation after cleaning:
  ```python
  assert set(['amount', 'date', 'customer_name', 'category', 'region']).issubset(df.columns), "Missing required columns"
  df = df.dropna(subset=['customer_name', 'amount', 'date'])
  df = df[df['amount'] > 0]
  ```

**8. Row-by-row INSERT is extremely slow — will not scale**
- **Where:** `pipeline.py:28–34` — `for _, row in df.iterrows()`
- **What happens:** Each row is inserted with a separate `execute()` call. For a CSV with 100,000 rows, this means 100,000 round trips to the database. This will be very slow and makes it much more likely that the 15-minute window is exceeded (triggering issue #5).
- **When it triggers:** Any CSV with more than a few thousand rows.
- **Fix:** Use `psycopg2.extras.execute_values()` or `execute_batch()` for bulk inserts:
  ```python
  from psycopg2.extras import execute_values
  values = [tuple(row) for _, row in df[['customer_name', 'amount', 'date', 'category', 'region']].iterrows()]
  execute_values(cur, "INSERT INTO transactions (customer_name, amount, date, category, region) VALUES %s", values)
  ```

**9. Entire DataFrame loaded into memory — OOM on large CSVs**
- **Where:** `pipeline.py:18` — `pd.read_csv(filepath)`
- **What happens:** The entire CSV is loaded into memory at once. A 2GB CSV will consume several GB of RAM (pandas overhead) and could crash the process with an out-of-memory error.
- **When it triggers:** When a CSV file is larger than available memory (or a significant fraction of it).
- **Fix:** Use chunked reading:
  ```python
  for chunk in pd.read_csv(filepath, chunksize=10000):
      # process and insert each chunk
  ```

**10. No Slack webhook error handling — notification failures crash the pipeline**
- **Where:** `pipeline.py:58–60` — `requests.post(os.getenv('SLACK_WEBHOOK_URL'), ...)`
- **What happens:** If the Slack webhook is unreachable, returns an error, or if `SLACK_WEBHOOK_URL` is unset (returns `None`), `requests.post()` raises an unhandled exception. This crashes `run_pipeline()` after all processing is done — the work is complete but the failure makes it look like the pipeline failed.
- **When it triggers:** Slack outage, network issue, misconfigured webhook URL, or missing env var.
- **Fix:** Wrap notification calls in try/except and never let alerting failures kill the pipeline:
  ```python
  try:
      requests.post(os.getenv('SLACK_WEBHOOK_URL'), json={...}, timeout=10)
  except Exception as e:
      logging.warning(f"Slack notification failed: {e}")
  ```

**11. Daily report writes to `./reports/` without ensuring the directory exists**
- **Where:** `pipeline.py:81` — `report_path = f"./reports/daily_{datetime.now().strftime('%Y%m%d')}.csv"`
- **What happens:** `df.to_csv(report_path)` will throw `FileNotFoundError` if the `./reports/` directory does not exist. The report is silently lost and the Slack notification (line 84) is never sent.
- **When it triggers:** First run on a fresh deployment where `./reports/` has not been manually created.
- **Fix:** Add `os.makedirs('./reports', exist_ok=True)` before writing.

**12. Timezone not set — daily report runs at ambiguous "08:00"**
- **Where:** `pipeline.py:90` — `schedule.every().day.at("08:00").do(generate_daily_report)`
- **What happens:** The `schedule` library uses the system's local time. If the server is in UTC but you expect 8am EST, the report fires at the wrong hour. After DST changes, it shifts by an hour. If moved to a cloud server in a different timezone, the report time changes silently.
- **When it triggers:** Deploying to any server where the system timezone differs from expectations, or on DST transitions.
- **Fix:** Set `TZ` environment variable explicitly, or use a scheduling library that supports timezone-aware scheduling (e.g., APScheduler).

**13. No execution timeout — a hung DB query or network call blocks the scheduler forever**
- **Where:** `pipeline.py:14` — `psycopg2.connect(os.getenv('DATABASE_URL'))` and `pipeline.py:78` — `pd.read_sql(query, conn)`
- **What happens:** Neither the DB connection nor the SQL queries have timeouts configured. If the database becomes unresponsive, `psycopg2.connect()` or `pd.read_sql()` will hang indefinitely, blocking the scheduler loop. No further pipeline runs or reports will execute.
- **When it triggers:** Database under heavy load, network partition, or Postgres connection slot exhaustion.
- **Fix:** Add connection timeouts:
  ```python
  def get_db_connection():
      return psycopg2.connect(os.getenv('DATABASE_URL'), connect_timeout=10)
  ```
  And add `statement_timeout` for queries via `options='-c statement_timeout=30000'` in the connection string.

**14. `os.rename()` fails across filesystems**
- **Where:** `pipeline.py:42` — `os.rename(filepath, archive_path)`
- **What happens:** `os.rename()` cannot move files across filesystem boundaries (e.g., if input and archive directories are on different mounts or volumes). It raises `OSError` with no recovery.
- **When it triggers:** When `CSV_INPUT_DIR` and `CSV_ARCHIVE_DIR` are on different filesystems (common in containerized or cloud environments where data dirs may be separate volumes).
- **Fix:** Use `shutil.move()` which handles cross-filesystem moves.

**15. Dependency versions not pinned — builds are not reproducible**
- **Where:** `requirements.txt:1–5`
- **What happens:** All dependencies are unpinned (`pandas`, `psycopg2-binary`, etc.). A `pip install` today and tomorrow could install different versions with breaking changes. Pandas especially has frequent API changes across major versions.
- **When it triggers:** Any re-deployment or fresh install that pulls newer (possibly incompatible) package versions.
- **Fix:** Pin exact versions: `pandas==2.2.1`, `psycopg2-binary==2.9.9`, etc. Use `pip freeze > requirements.txt` from a working environment.

---

### Worth noting — Low risk but worth a look

**16. No logging — only `print()` statements**
- **Where:** `pipeline.py:55, 62` — `print()` calls throughout
- **What happens:** `print()` goes to stdout with no timestamps, log levels, or structured format. In a long-running server process, there is no log rotation, no way to filter by severity, and no persistent record of what happened unless stdout is explicitly redirected.
- **When it triggers:** Always — this is a quality-of-life issue that makes debugging production incidents significantly harder.
- **Fix:** Use Python's `logging` module:
  ```python
  import logging
  logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
  ```

**17. No heartbeat or health check — no way to know if the scheduler is alive**
- **Where:** `pipeline.py:92–97` — main loop
- **What happens:** The `while True` loop runs silently. If the process crashes, gets OOM-killed, or the schedule library silently stops working, there is no external indicator. Nobody knows the pipeline has stopped until the Slack messages stop arriving (and even then, it could just mean there were no CSVs to process).
- **When it triggers:** Process crash, OOM kill, or silent scheduler failure.
- **Fix:** Add a periodic heartbeat — e.g., write a timestamp to a health check file, or send a periodic ping to an uptime monitor (Healthchecks.io, Cronitor, etc.).

**18. No graceful shutdown handling**
- **Where:** `pipeline.py:95–97` — `while True` loop
- **What happens:** If the process receives SIGTERM (e.g., during deployment or server shutdown), it is killed mid-run. If this happens during a DB insert, partial data may be committed (or the connection is left dangling on the Postgres side).
- **When it triggers:** Any process restart, deployment, or server shutdown.
- **Fix:** Add a signal handler:
  ```python
  import signal
  shutdown = False
  def handle_signal(sig, frame):
      global shutdown
      shutdown = True
  signal.signal(signal.SIGTERM, handle_signal)
  # In the main loop: check `if shutdown: break`
  ```

**19. No backfill mechanism — missed runs are lost**
- **Where:** `pipeline.py:89` — schedule configuration
- **What happens:** If the pipeline is down for several hours, the `schedule` library does not backfill missed runs. When the process restarts, it just resumes from the current time. Any CSVs that arrived during downtime will be picked up on the next run (since they accumulate in the input dir), but the daily report has no way to backfill missed days.
- **When it triggers:** After any downtime longer than the schedule interval.
- **Fix:** For the daily report, add a check on startup that looks for missing report dates and generates them retroactively.

**20. No record count reconciliation**
- **Where:** `pipeline.py:46–62` — `run_pipeline()`
- **What happens:** The pipeline counts records processed and sends the total to Slack, but there is no verification that the number of records inserted into Postgres matches the number of rows in the source CSVs. If inserts silently fail (e.g., constraint violations, truncation), records are lost with no indication.
- **When it triggers:** When any insert is silently skipped or when a database constraint rejects a row.
- **Fix:** After the commit, query the count of records just inserted and compare with `len(df)`. Log a warning if they differ.

**21. Relative paths for data directories — fragile working directory assumption**
- **Where:** `.env:2–3` — `CSV_INPUT_DIR=./data/incoming`, `CSV_ARCHIVE_DIR=./data/processed`
- **What happens:** The `./` prefix is relative to the current working directory. If the process is started from a different directory (e.g., via systemd, cron, or a process manager), the paths resolve to the wrong location.
- **When it triggers:** When the process is started from any directory other than the project root.
- **Fix:** Use absolute paths in the `.env` file, or resolve relative paths against `__file__` at startup.

**22. Daily report query uses `CURRENT_DATE` — timezone-sensitive**
- **Where:** `pipeline.py:73` — `WHERE date >= CURRENT_DATE - INTERVAL '1 day'`
- **What happens:** `CURRENT_DATE` uses the Postgres server's timezone setting. If the Postgres server and the application server are in different timezones, the report may include or exclude transactions from the boundary hours.
- **When it triggers:** When the Postgres timezone differs from the expected report timezone.
- **Fix:** Use explicit timezone-aware timestamps in the query, e.g., `WHERE date >= (NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '1 day'`.

---

### Risk Summary

| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1 | No error handling — single bad CSV kills pipeline | Critical | Reliability |
| 2 | Database connection leak on errors | Critical | Reliability |
| 3 | No idempotency — duplicates on re-run | Critical | Data Integrity |
| 4 | `.env` with plaintext credentials, no `.gitignore` | Critical | Security |
| 5 | No overlap protection for 15-minute jobs | Critical | Concurrency |
| 6 | Partial commit then failed archive — inconsistent state | Critical | Data Integrity |
| 7 | No data validation on CSV input | High | Data Integrity |
| 8 | Row-by-row INSERT will not scale | High | Performance |
| 9 | Entire CSV loaded into memory — OOM risk | High | Reliability |
| 10 | Slack notification failure crashes pipeline | High | Reliability |
| 11 | Reports directory may not exist | High | Reliability |
| 12 | Timezone not set for scheduled jobs | High | Scheduling |
| 13 | No execution timeout on DB calls | High | Reliability |
| 14 | `os.rename()` fails across filesystems | High | Reliability |
| 15 | Dependency versions not pinned | High | Deployment |
| 16 | No logging — only `print()` | Worth noting | Observability |
| 17 | No heartbeat or health check | Worth noting | Observability |
| 18 | No graceful shutdown handling | Worth noting | Reliability |
| 19 | No backfill mechanism for missed runs | Worth noting | Scheduling |
| 20 | No record count reconciliation | Worth noting | Data Integrity |
| 21 | Relative paths for data directories | Worth noting | Deployment |
| 22 | Daily report query timezone-sensitive | Worth noting | Data Integrity |

---

### Deployment Checklist

Before deploying, verify:
- [ ] Add try/except error handling around CSV processing and DB operations (issues #1, #2)
- [ ] Use context managers or try/finally for all database connections (#2)
- [ ] Add idempotency — `ON CONFLICT` clause or file-tracking table (#3)
- [ ] Remove `.env` from version control, add `.gitignore`, rotate credentials (#4)
- [ ] Add a mutex/lock to prevent overlapping pipeline runs (#5)
- [ ] Make file archival atomic with processing, handle `os.rename` failures (#6)
- [ ] Add input validation for CSV schema and data values (#7)
- [ ] Switch to bulk inserts with `execute_values()` (#8)
- [ ] Add chunked CSV reading for large files (#9)
- [ ] Wrap Slack notifications in try/except so failures don't crash the pipeline (#10)
- [ ] Create `./reports/` directory at startup or use `os.makedirs` (#11)
- [ ] Set explicit timezone for scheduled jobs (#12)
- [ ] Add connection and query timeouts to Postgres (#13)
- [ ] Replace `os.rename()` with `shutil.move()` (#14)
- [ ] Pin all dependency versions in `requirements.txt` (#15)

---

**Verdict:** This pipeline has several issues that are near-certain to cause production failures. The complete absence of error handling means the first malformed CSV will crash the pipeline, leak a DB connection, and skip all remaining files — silently. Combined with no idempotency and no overlap protection, recovering from any failure will likely produce duplicate data. These must be fixed before deployment.

**Suggested next action:** Add comprehensive error handling with try/except/finally around `process_csv()` and use context managers for DB connections. This single change addresses issues #1 and #2 and prevents the most likely cascading failures.

---

> Want me to fix any of these? Or should I run a deeper audit on a specific area?
