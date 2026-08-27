# B03 Database Engineering
scope: TypeORM; migrations; transactions/ACID; race conditions; locking; query opt; pooling

## migrations
- `synchronize:false` always; guard it on NODE_ENV. `true` DROPs columns/tables => permanent data loss.
- write and test `down()`. never edit a deployed migration (causes schema drift across envs).
- one logical change per migration.
- always read generated migrations before commit — generator emits drop+create instead of rename.
- run migrations as a separate job before app deploy; on-boot migration races across N instances.
- test on a copy of production data: passes on empty db, locks 50M rows in prod.
- `ALTER TABLE ADD COLUMN NOT NULL DEFAULT` can rewrite table + ACCESS EXCLUSIVE lock. safe pattern: add nullable -> backfill in batches -> add constraint.
- breaking schema change + zero downtime = expand-and-contract (add -> deploy code reading both -> remove next release).

## transactions
- keep short. long tx = held locks + pool starvation + deadlock risk.
- NEVER call external APIs/email/payment inside a tx (holds locks; cannot roll back a sent email). enqueue instead (B05).
- use the `manager` passed into the callback. using `this.repo` inside silently runs OUTSIDE the tx and is not rolled back.
- lock resources in a globally consistent order (e.g. User then Account) — prevents circular wait.
- retry on PG `40P01` (deadlock) with exponential backoff + jitter.
- isolation: READ COMMITTED default; SERIALIZABLE only for financial ops (throughput cost + serialization failures need retry).

## locking
- pessimistic (`lock:{mode:'pessimistic_write'}` = SELECT FOR UPDATE): high contention, critical updates (stock, seats, balance). must be inside the same transaction; lock releases on COMMIT.
- optimistic (`@VersionColumn`): low contention, long user edits. catch `OptimisticLockVersionMismatchError`.
- correct optimistic write: `repo.update({id, version}, patch)` then check `affected===0` -> ConflictException. manual `if (doc.version !== expected)` then save is TOCTOU-racy.
- PG note: `FOR UPDATE` does NOT block plain SELECT (MVCC); it blocks FOR UPDATE/FOR SHARE/UPDATE/DELETE.

## query
- index every column used in WHERE/JOIN/ORDER BY. composite index obeys left-most prefix rule.
- always `select:[...]` and paginate list endpoints. deep offsets: use keyset/cursor, OFFSET still scans skipped rows.
- N+1 -> `relations:[...]` (1 JOIN vs N+1 roundtrips). but deep nesting (`posts.comments`) creates cartesian blowup; sometimes 2 queries + in-app map (DataLoader) is faster.
- enable SQL logging in dev; `pg_stat_statements` + `EXPLAIN ANALYZE` in prod.
- `onDelete:'CASCADE'` can silently delete 100k rows and is irreversible post-commit; consider RESTRICT/soft delete.

## pooling
- total = instances x poolSize (x (1+replicas) if replication, see B06) must stay under `max_connections`.
- dev ~10, prod 20-50, high traffic 50-100. the `(cores*2)+spindles` formula sizes the DB server, not the app pool.

## error mapping
- 23505 unique -> 409; 23503 fk / 23502 not-null / 23514 check -> 400; 40P01 deadlock -> retry.

## slide-errata
1. slide30 optimistic-lock example manually compares version then saves — still racy (TOCTOU). use conditional update + affected check.
2. bank-transfer example calls `manager.debit()/credit()` — not real EntityManager methods, pseudo-code only.
3. deadlock retry uses fixed `sleep(100)` — needs exponential backoff + jitter or retries re-collide.
4. slide says `pessimistic_write` "blocks both reads and writes" — false on PostgreSQL MVCC (plain SELECT unaffected).
5. test setup uses `synchronize:true, dropSchema:true` => tests never exercise your migrations; green tests + failing prod migrate is possible.
6. TypeORM does not support true nested transactions/savepoints via nested `dataSource.transaction()` — inner gets a separate connection and can deadlock against the outer.
7. this deck uses correct `findOne({where:{id}})` (TypeORM 0.3) throughout; B04 regresses to removed 0.2 `findOne(id)`.
