# Automation Pipeline Edge Case Reference

Use this file when auditing automation pipelines: scripts, scheduled jobs, event-driven workflows, data sync pipelines, CI/CD automation, and similar.

---

## Pipeline Resilience

- [ ] No idempotency — re-running the pipeline creates duplicate records or side effects
- [ ] No deduplication check — same event processed multiple times if triggered twice
- [ ] Pipeline fails silently — error occurs mid-run, partial state written, no alert
- [ ] No dead letter queue / failure log — failed items disappear with no record
- [ ] Long-running job has no progress checkpoint — crash at step 9 of 10 requires full restart
- [ ] External dependency assumed available — if API or DB is down, entire pipeline fails with no retry
- [ ] No dry-run mode — can't safely test without side effects
- [ ] No circuit breaker — repeated failures to external service cause cascading timeouts
- [ ] No graceful shutdown — killing the process mid-run leaves data in inconsistent state

---

## Data Integrity

- [ ] Schema mismatch between source and destination — a new field from the source breaks the mapping silently
- [ ] Null / empty string not handled — downstream process crashes on unexpected null
- [ ] Encoding issues — special characters (UTF-8 vs latin1) corrupt data silently
- [ ] Floating point values not rounded — money/quantity fields accumulate rounding errors
- [ ] Date/time timezone not normalised — records written in local time, read as UTC elsewhere
- [ ] Arrays assumed non-empty — `.map()` / loop on empty array is fine, but `.find()` returning `undefined` then accessed causes crash
- [ ] No data validation at pipeline boundaries — garbage in, garbage persisted
- [ ] Batch size not limited — pipeline tries to process 1M records in memory, OOM
- [ ] No record count reconciliation — 1000 records in, 998 out, nobody notices the 2 that dropped

---

## Scheduling & Timing

- [ ] Cron job overlap — job takes longer than interval, two instances run concurrently, race condition
- [ ] No lock/mutex on scheduled job — parallel execution corrupts shared state
- [ ] Timezone not set on cron — runs at wrong time after DST change
- [ ] Job silently stops running — no alerting if job hasn't fired in expected window
- [ ] No execution timeout — job hangs forever, blocks next run
- [ ] Clock drift between services — event ordering assumptions break when clocks disagree
- [ ] Backfill logic missing — if the job was down for 3 hours, there's no way to reprocess missed windows

---

## State & Concurrency

- [ ] Shared mutable state without locking — two workers modify the same record, last write wins silently
- [ ] Queue consumer doesn't acknowledge — message redelivered endlessly or lost
- [ ] No distributed lock — multiple instances of the same job run in parallel across servers
- [ ] Optimistic concurrency not used — stale reads lead to overwriting fresh data
- [ ] Status field used as a lock — race between "check status" and "update status" (TOCTOU)
- [ ] No poison pill handling — one malformed message blocks the entire queue

---

## External Triggers / Webhooks

- [ ] Webhook endpoint not authenticated — anyone can trigger the pipeline
- [ ] Payload format not validated — unexpected shape crashes handler
- [ ] No response returned promptly — webhook sender times out, resends, pipeline runs twice
- [ ] Delivery not acknowledged — sender marks as failed and retries, causing duplicates
- [ ] No replay protection — replayed old webhooks re-process stale data
- [ ] No ordering guarantee — events arrive out of order, pipeline processes "delete" before "create"

---

## Secrets & Credentials

- [ ] API keys hardcoded in source — visible in git history even after removal
- [ ] No key rotation plan — single long-lived key, if compromised no rotation procedure
- [ ] Secrets logged in plain text — API key appears in error messages or debug output
- [ ] Credentials shared across environments — prod key used in dev, one mistake affects production
- [ ] No secret expiry handling — token expires, pipeline breaks with cryptic auth error
- [ ] `.env` file committed to repo — secrets in version control

---

## File & Storage Operations

- [ ] File assumed to exist — no existence check before read, throws uncaught error
- [ ] Write destination not created — write fails if directory doesn't exist
- [ ] Temp files not cleaned up — disk fills over time
- [ ] Large file read into memory at once — OOM on big files, should stream
- [ ] Race condition on file write — concurrent runs write to same file, corruption
- [ ] No file locking — two processes append to same log, interleaved output

---

## Notification & Alerting

- [ ] No success/failure notification — pipeline runs in the dark, no visibility
- [ ] Error notification sends full stack trace to user — exposes internals, confusing
- [ ] Alerting on every retry attempt — noisy, alert fatigue
- [ ] No summary report for batch jobs — can't tell how many records succeeded vs failed
- [ ] No heartbeat / health check — can't tell if the pipeline is running at all
- [ ] Alerts go to a single person — they're on holiday, nobody notices failures

---

## Deployment & Environment

- [ ] No rollback plan — broken deployment requires manual intervention
- [ ] Environment variables differ between deploy targets — works in staging, breaks in prod
- [ ] No canary / gradual rollout — bad version goes to 100% traffic immediately
- [ ] Dependency versions not pinned — `npm install` pulls different versions on CI vs local
- [ ] No health check endpoint — orchestrator can't tell if service is healthy after deploy
