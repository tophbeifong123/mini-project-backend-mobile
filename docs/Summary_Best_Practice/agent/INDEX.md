# Backend course — agent notes
Compact rules + verified slide errata. Source: Backend01-06 PDFs (parent dir). Thai long-form versions: ../For_human/Backend0N.md

- Backend01.md — architecture choice, Docker, images/layers, secrets
- Backend02.md — NestJS structure, DI, scopes, validation, unit testing
- Backend03.md — TypeORM, migrations, transactions, locking, query opt, pooling
- Backend04.md — Redis caching, invalidation, stampede/avalanche, atomic ops, locks
- Backend05.md — pub/sub vs queues, BullMQ, retries, idempotency, rate limits
- Backend06.md — stateless, Nginx LB, PG replication, health checks, observability

Cross-cutting invariants:
- at-least-once everywhere => handlers idempotent (B05)
- shared state in Redis, never in process memory (B02,B04,B06)
- external calls never inside DB transactions => enqueue (B03,B05)
- TTL + jitter on every cached key (B04)
- total DB connections = instances x (1+replicas) x poolSize (B03,B06)
- measure before scaling: queries -> cache -> queues -> instances (B06)

"slide-errata" sections list code in the source PDFs that is broken or wrong. Do not reproduce it.

## applied in this project
These notes are the rulebook behind [`docs/Architecture/architecture.md`](../../Architecture/architecture.md) and [`CLAUDE.md`](../../../CLAUDE.md).
Flash Sale System maps to them as: B02 modular NestJS · B03 atomic decrement + UNIQUE constraint + pooling ·
B04 cache-aside + TTL jitter + Lua atomicity + eviction policy · B05 BullMQ idempotency + retries + Bull-Board auth ·
B06 stateless JWT + Nginx least_conn + read-write split + k6.
Every "slide-errata" item below is code that appears in the source PDFs and is WRONG — do not reproduce it.
