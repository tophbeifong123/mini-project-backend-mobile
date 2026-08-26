#!/bin/sh
# =============================================================================
# app-entrypoint — ทำให้ `podman compose up -d` ครั้งเดียวได้ระบบที่ใช้งานได้จริง
#
#   RUN_MIGRATIONS=true  (ตั้งไว้เฉพาะ app-1)
#       → รัน dist/database/migrate-and-seed.js  (migration + seed DB + seed Redis)
#       → แล้วค่อย exec server
#   ไม่ได้ตั้ง (app-2 / app-3)
#       → รอจนกว่า schema + seed จะพร้อม แล้วค่อย exec server
#         (กัน 3 instance แย่งกันรัน migration พร้อมกัน = deadlock/duplicate)
#
# ⚠️ ไม่มี psql ใน node:alpine — ใช้ node + pg (เป็น dependency อยู่แล้ว) เช็คแทน
# =============================================================================
set -e

log() { echo "[app-entrypoint][${INSTANCE_ID:-app}] $*"; }

# --- probe: schema พร้อม + มี product อย่างน้อย 1 แถวหรือยัง -------------------
schema_ready() {
  node -e '
    const { Client } = require("pg");
    const c = new Client({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      connectionTimeoutMillis: 3000,
    });
    c.connect()
      .then(() => c.query("SELECT to_regclass('"'"'public.products'"'"') AS t"))
      .then((r) => {
        if (!r.rows[0].t) throw new Error("products table not found");
        return c.query("SELECT COUNT(*)::int AS n FROM products");
      })
      .then((r) => {
        if (r.rows[0].n < 1) throw new Error("products table is empty");
        return c.end();
      })
      .then(() => process.exit(0))
      .catch(async () => { try { await c.end(); } catch (e) {} process.exit(1); });
  ' >/dev/null 2>&1
}

# --- probe: stock counter ใน redis-data ถูก seed แล้วหรือยัง -------------------
# ใช้ SCAN ไม่ใช่ KEYS (CLAUDE.md §6) — ioredis เป็น dependency ของ prod อยู่แล้ว
stock_seeded() {
  node -e '
    const Redis = require("ioredis");
    const r = new Redis({
      host: process.env.REDIS_DATA_HOST,
      port: Number(process.env.REDIS_DATA_PORT || 6379),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    r.connect()
      .then(() => r.scan(0, "MATCH", "stock:flash_sale:*", "COUNT", 100))
      .then(([, keys]) => {
        r.disconnect();
        process.exit(keys && keys.length > 0 ? 0 : 1);
      })
      .catch(() => { try { r.disconnect(); } catch (e) {} process.exit(1); });
  ' >/dev/null 2>&1
}

if [ "$RUN_MIGRATIONS" = "true" ]; then
  log "RUN_MIGRATIONS=true -> running migrations + seed"
  node dist/database/migrate-and-seed.js
  log "migrations + seed finished"
else
  log "waiting for app-1 to finish migrations + seed..."
  i=0
  until schema_ready && stock_seeded; do
    i=$((i + 1))
    if [ "$i" -ge 120 ]; then
      log "ERROR: schema still not ready after 240s - giving up"
      exit 1
    fi
    sleep 2
  done
  log "schema + stock counters are ready"
fi

log "starting server: $*"
exec "$@"
