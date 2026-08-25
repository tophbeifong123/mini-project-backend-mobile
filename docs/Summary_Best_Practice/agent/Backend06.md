# B06 Scaling, Load Balancing & Observability
scope: horizontal scaling; stateless; Nginx LB; PG replication; health checks; logging; metrics; load testing

## stateless (precondition for everything else)
- no in-memory sessions/cache/counters. next request may hit another instance; restart wipes it.
- session in Redis, or JWT. JWT = validate anywhere, zero DB reads, BUT cannot be revoked — needs short TTL + refresh token, or a Redis blacklist (which reintroduces shared state).
- all instances run the same version; rolling updates.
- graceful shutdown: stop accepting -> drain in-flight -> close. otherwise every deploy emits 502s.
- recompute pool on scale-out: `instances x (1 + replicas) x poolSize <= 80% of max_connections`. this is the #1 cause of "too many connections" after scaling. consider PgBouncer at high instance counts.

## load balancing
- round robin: default for stateless, equal-cost requests.
- least_conn: variable duration, uploads, long-polling, websockets.
- ip_hash: avoid. NAT/proxies skew distribution, node failure drops that cohort's sessions, breaks scale-in.
- set `max_fails` + `fail_timeout`; free Nginx has PASSIVE checks only (`health_check` requires Nginx Plus).
- set proxy_connect/send/read timeouts or hung upstreams pin Nginx worker connections.
- forward `X-Real-IP` / `X-Forwarded-For` or rate-limiting/audit/geo all see the LB's IP.
- one Nginx is an SPOF — run 2 + VIP/DNS failover, or use a managed LB.

## replication
- primary=writes, replicas=reads (80-90% of queries). does NOT help write throughput — that needs sharding/partitioning/queues.
- lag: 10-100ms normal, 100ms-1s under load. alert >1s.
- read-your-writes must hit primary (or run inside a transaction, which always uses master). otherwise user creates a record and immediately 404s — reproduces only under load.
- TypeORM: `replication:{master, slaves}`; pool is created per master AND per slave.
- monitor `pg_replication_slots`: a slot left by a dead replica makes primary retain WAL until disk fills and writes stop. use `max_slot_wal_keep_size` or drop stale slots.
- primary config: `wal_level=replica`, `max_wal_senders`=replicas+1, replication slots, dedicated `replicator` role.
- rehearse failover (Patroni/repmgr).

## health checks
- SPLIT them. `/health/live`: cheap, no dependency checks. `/health/ready`: DB+Redis.
- liveness must not check the DB: a brief DB outage would restart every container simultaneously, self-inflicted outage.
- readiness fail -> removed from LB, container keeps running and reconnects.
- keep the endpoint cheap; heavy /health x probes x instances can itself cause cascading removal when the DB slows.

## observability
- structured JSON logs; correlation/trace id on every request, propagated to workers.
- never log passwords, tokens, PII, card data. logs land in wide-access long-retention storage.
- min level `info` in prod. debug volume fills disk, inflates cost, buries signal.
- centralized logging (ELK/CloudWatch) — logs split across 5 instances are unusable during an incident.
- metrics: request rate, error rate (split 4xx/5xx), p50/p95/p99, queue depth, cache hit ratio, replication lag, pool utilization.
- measure percentiles, not averages. p99 is the angriest user and usually the one with the most data.
- log volume can exceed compute cost; sample high-volume paths.

## targets
- RPS 1000+ typical API; p50<100ms; p95<200ms; p99<500ms; error rate <0.1%; replication lag <1s; ~45% CPU/instance post-scale.
- reference: 1 instance 500 RPS/p95 300ms -> 3 instances 1400 RPS/p95 150ms (~2.8x, not 3x). if the DB is the bottleneck, added instances return ~nothing.
- order of work: measure -> fix queries+indexes (B03) -> cache (B04) -> offload to queues (B05) -> THEN scale out. scaling an app with N+1 queries just buys faster bad queries.
- load test with k6 (ramp -> peak -> ramp down) for a real baseline.

## slide-errata
1. slide44 claims "Docker marks unhealthy -> Nginx stops routing". FALSE — Nginx cannot read Docker health status. It only ejects an upstream after `max_fails` real request failures within `fail_timeout`. Real behavior requires Kubernetes readinessProbe, Swarm, or Nginx Plus. Anyone following this believes they have failover they do not have.
2. same for Dockerfile `HEALTHCHECK` — it only changes `docker ps` status outside an orchestrator.
3. deck uses ONE `/health` (DB + memory) for both probe types, contradicting its own liveness/readiness table. As a k8s livenessProbe this restart-loops every pod whenever the DB blips.
4. "TypeORM detects connection failures, skips failed replica, master serves reads if all replicas down" is overstated — TypeORM has no active replica health checks; it round-robins slaves and failover depends on driver error behavior. Do not design around it.
5. connection math on slide10 (`instances x poolSize`) ignores that replication creates a pool per master and per slave — real total is `instances x (1+slaves) x poolSize`. Under-counts by several times.
6. replication slot exhaustion risk (primary disk fill) is never mentioned.
7. architecture diagram shows a single Nginx as sole ingress while the deck targets "99.9%+ uptime, no single point of failure".
8. JWT presented as "zero database queries for auth" with no mention of the revocation limitation.
9. compose replica uses `pg_basebackup -U postgres` while the init script creates a dedicated `replicator` role (later slide uses `-U replicator`). Inconsistent.
10. "3 instances = 2.8x RPS" is an illustration, not a guarantee.
