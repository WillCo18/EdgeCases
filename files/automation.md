# Automation Pipeline Edge Case Reference

Use this file when auditing automation pipelines: scripts, scheduled jobs, event-driven workflows, data sync pipelines, and similar.

---

## Pipeline Resilience

- [ ] No idempotency — re-running the pipeline creates duplicate records or side effects
- [ ] No deduplication check — same event processed multiple times if triggered twice
- [ ] Pipeline fails silently — error occurs mid-run, partial state written, no alert
- [ ] No dead letter queue / failure log — failed items disappear with no record
- [ ] Long-running job has no progress checkpoint — crash at step 9 of 10 requires full restart
- [ ] External dependency assumed available — if API or DB is down, entire pipeline fails with no retry
- [ ] No dry-run mode — can't safely test without side effects

---

## Data Integrity

- [ ] Schema mismatch between source and destination — a new field from the source breaks the mapping silently
- [ ] Null / empty string not handled — downstream process crashes on unexpected null
- [ ] Encoding issues — special characters (UTF-8 vs latin1) corrupt data silently
- [ ] Floating point values not rounded — money/quantity fields accumulate rounding errors
- [ ] Date/time timezone not normalised — records written in local time, read as UTC elsewhere
- [ ] Arrays assumed non-empty — `.map()` / loop on empty array is fine, but `.find()` returning `undefined` then accessed causes crash

---

## Scheduling & Timing

- [ ] Cron job overlap — job takes longer than interval, two instances run concurrently, race condition
- [ ] No lock/mutex on scheduled job — parallel execution corrupts shared state
- [ ] Timezone not set on cron — runs at wrong time after DST change
- [ ] Job silently stops running — no alerting if job hasn't fired in expected window

---

## External Triggers / Webhooks

- [ ] Webhook endpoint not authenticated — anyone can trigger the pipeline
- [ ] Payload format not validated — unexpected shape crashes handler
- [ ] No response returned promptly — webhook sender times out, resends, pipeline runs twice
- [ ] Delivery not acknowledged — sender marks as failed and retries, causing duplicates
- [ ] No replay protection — replayed old webhooks re-process stale data

---

## File & Storage Operations

- [ ] File assumed to exist — no existence check before read, throws uncaught error
- [ ] Write destination not created — write fails if directory doesn't exist
- [ ] Temp files not cleaned up — disk fills over time
- [ ] Large file read into memory at once — OOM on big files, should stream
- [ ] Race condition on file write — concurrent runs write to same file, corruption

---

## Notification & Alerting

- [ ] No success/failure notification — pipeline runs in the dark, no visibility
- [ ] Error notification sends full stack trace to user — exposes internals, confusing
- [ ] Alerting on every retry attempt — noisy, alert fatigue
- [ ] No summary report for batch jobs — can't tell how many records succeeded vs failed
