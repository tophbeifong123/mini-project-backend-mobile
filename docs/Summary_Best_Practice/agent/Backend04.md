# B04 Redis: Caching & Atomic Ops
scope: cache strategies; invalidation; stampede/avalanche; atomic commands; distributed locks; eviction

## when
- cache: read-heavy, expensive queries, semi-static data, hot endpoints.
- do not cache: write-heavy, rapidly changing, strict-consistency data.
- hit ratio = hits/(hits+misses); target >80%. latency ~100ms DB -> ~1ms cache.

## rules
- TTL on every key. no-TTL key = memory leak until maxmemory eviction starts dropping live data.
- TTL by volatility: 30s-5m volatile, 10m-1h semi-static, 1h-24h static.
- add random jitter to TTL — equal TTLs set during warm-up all expire together (avalanche).
- wrap every cache call in try/catch with DB fallback. Redis is an optimization; if it becomes required, you added an SPOF.
- key format `{namespace}:{entity}:{id}:{field}`. central key-builder helper, not ad-hoc strings.
- invalidate the whole dependency chain on write (`user:1`, `user:1:posts`, `users:list`).
- TTL is the safety net; never rely on invalidation alone — some interleaving always leaves stale data.
- cache only hot data; RAM cost/GB >> disk.
- values >1MB: split or compress.

## strategies
- cache-aside (default, read-heavy): read cache -> miss -> DB -> populate. first request always cold; stampede risk.
- write-through: write DB then cache. fresh after write, higher write latency, caches possibly-unread data.
- write-behind: cache first, async flush. lowest latency; DATA LOSS if cache dies pre-flush. counters/analytics only, never payments/auth.
- ordering: prefer update-DB-then-DEL-cache over DEL-then-update; still racy — pair with short TTL or delayed double-delete.

## atomicity
- counters: `INCR`/`INCRBY`. get->+1->set loses updates across instances.
- distributed lock: `SET key <uuid-token> EX ttl NX`.
  - TTL mandatory (crashed worker otherwise locks forever)
  - unique token per holder
  - release via Lua compare-and-del (split GET/DEL lets you delete someone else's lock)
  - `try/finally`, and check `if (token)` before releasing
  - long jobs need heartbeat/`extendLock`
- locks are best-effort (GC pause, clock drift). correctness must come from idempotency + DB unique constraints. Redlock is academically contested for correctness; instances must be truly independent, not primary+replica.

## ops
- `KEYS` is O(N) and blocks the whole single-threaded server. use `SCAN` or maintain an index SET.
- set `maxmemory` + policy: cache-only `allkeys-lru`; mixed `volatile-lru`; critical `noeviction`.
- if the same Redis holds queues (B05), LRU eviction will delete jobs — separate instance/db.
- monitor: keyspace_hits/misses, used_memory, evicted_keys, `SLOWLOG GET 10`.
- reuse connections/pool.
- single Redis is an SPOF for sessions — plan Sentinel/managed Redis.

## slide-errata
1. invalidation example calls `redis.keys(pattern)` while its own comment says use SCAN. blocks Redis in prod.
2. `cache.set(lockKey,'1',{ttl:10,nx:true})` — `@nestjs/cache-manager` Cache has no `nx`. use raw ioredis `set(k,v,'EX',10,'NX')`.
3. `cache.ttl(key)` also does not exist on cache-manager; use `redis.ttl`.
4. stampede solution 1 recurses `return this.getPopularPost()` unbounded — if the lock holder dies, callers spin until TTL; risk of stack overflow. use bounded retry loop + backoff + direct-DB fallback.
5. same example releases the lock with bare `cache.del(lockKey)` without token comparison — contradicts its own lock section, can delete another holder's lock.
6. `finally { releaseLock(key, token) }` dereferences `token` that may be null/undefined if acquire threw.
7. cache-aside example wraps `cache.set` in the same try as the DB read, so a cache write failure re-queries the DB in catch (duplicate query). scope the try to the cache calls.
8. `this.userRepo.findOne(id)` (Basic Cache Operations) is removed TypeORM 0.2 API; use `findOne({where:{id}})` as B03 does.
9. deck never covers Redis HA.
