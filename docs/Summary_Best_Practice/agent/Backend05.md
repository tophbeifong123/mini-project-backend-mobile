# B05 Async Communication
scope: sync vs async; Redis Pub/Sub; BullMQ queues; retries; resilient email; delayed/priority/rate-limit/concurrency

## decide
- rule: op >1s OR result not needed immediately => async.
- pub/sub: one-to-many broadcast. NO persistence, NO ack, NO retry, NO ordering. message lost if no subscriber.
  - use for: cache invalidation, real-time notifications, metrics, multi-instance sync.
  - never for: payments, user creation, anything that must happen.
- queue: point-to-point, persisted in Redis, ack, auto-retry, FIFO within queue.
  - use for: email, payments, media processing, batch, scheduled work.
- pub/sub + N instances = N duplicate executions. side-effecting logic belongs in a queue, not a subscriber.
- Redis client in subscribe mode cannot run other commands => separate publisher and subscriber clients.
- channel naming: `resource.action` (user.created, order.placed).

## reliability
- delivery is AT-LEAST-ONCE. every handler must be idempotent (dedupe table on jobId or business key). worker can die post-work pre-ack.
- retries: `attempts:3-5`, exponential backoff, PLUS jitter (deck omits jitter; without it failed jobs re-collide).
- split transient vs permanent failure. SMTP 4xx (421/450/451/452) retry; 5xx (550/551/552/553) do NOT retry — wastes attempts and hurts sender reputation.
- `removeOnFail:false` (keep evidence), `removeOnComplete:{age:3600}` or a count (else Redis grows unbounded).
- dead-letter queue + alert on permanent failure, otherwise failures are silent data loss.
- job timeout; BullMQ has no `timeout` option — implement via `Promise.race`.
- graceful worker shutdown or every deploy creates stalled jobs.
- stalled recovery re-runs the whole job (again: idempotency).
- payload = reference (`videoUrl`, id), never binary/buffer — jobs live in RAM.
- changing payload shape breaks jobs already queued; support both shapes for one release.

## throughput
- concurrency: CPU-bound 1-2, I/O-bound 5-20, light 20-50. high concurrency on CPU work starves the event loop.
- rate limiter matched to provider quota (SendGrid 100/s, Mailgun 1000/hr, Stripe 100/s). exceeding => 429/spam-flagging, and retries worsen it.
- priority: 1 password-reset/security, 2-3 premium, 4-6 normal, 7-9 bulk, 10 background.
- delayed jobs for per-user scheduling (trial expiry, reminders); cancel via stored jobId + `job.remove()`.
- separate queue per job type — heavy video work must not block email.
- scale: `pm2 -i 4` x concurrency 5 = 20 parallel.

## ops
- separate Redis (or db) for queues vs cache; cache eviction policy will delete jobs.
- enable AOF on the queue Redis.
- Bull Board must sit behind auth — it exposes payloads and allows retry/remove.
- monitor: waiting, active, failed/hr, processing rate, avg duration, p95/p99, queue lag (age of oldest waiting job), stalled count.
- FIFO applies to pickup, not completion. strict ordering needs concurrency 1 or FlowProducer.

## slide-errata
1. deck mixes Bull and BullMQ: installs `@nestjs/bull bullmq` but imports `from 'bull'`. `@nestjs/bull` is the adapter for Bull v3/v4. pick `@nestjs/bullmq`+`bullmq` (preferred) or `@nestjs/bull`+`bull`.
2. `timeout` job option does not exist in BullMQ (Bull v4 only).
3. `job.progress(n)` is Bull; BullMQ uses `job.updateProgress(n)`.
4. `queue.on('completed'|'failed'|'active'|'waiting')` does not work on BullMQ Queue — use `QueueEvents` or `@OnWorkerEvent()`.
5. deck claims both "At-least-once delivery" and "Exactly-once: each job processed once" on adjacent slides. exactly-once is false.
6. DLQ example pushes to DLQ on last attempt then still `throw error` -> extra attempt + duplicate DLQ entries. return instead of throwing on the final attempt.
7. `limiter:{max,duration}` is placed on `registerQueue`; in BullMQ it is a Worker option.
8. "should not retry on permanent failure" test expects `result.success===false` but the shown processor throws unconditionally — the 5xx branch is missing. add: if responseCode 550-559 -> mark permanent, return; else throw.
9. publisher example uses `this.db.user.create()` (Prisma) while the course uses TypeORM.
10. Bull Board mounted at `/admin/queues` with no auth middleware.
