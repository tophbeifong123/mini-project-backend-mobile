#!/bin/bash
# =============================================================================
# postgres-replica entrypoint
#   ถ้า data dir ว่าง → pg_basebackup จาก primary (พร้อม standby.signal)
#   ถ้ามีข้อมูลอยู่แล้ว → ข้ามไปเลย แล้วส่งต่อให้ entrypoint มาตรฐาน
# =============================================================================
set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PRIMARY_HOST="${PRIMARY_HOST:-postgres-primary}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
SLOT_NAME="${REPLICATION_SLOT_NAME:-replica_1_slot}"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[replica] data dir is empty -> base backup from ${PRIMARY_HOST}:${PRIMARY_PORT} as ${REPL_USER}"

  until pg_basebackup \
        --host="$PRIMARY_HOST" \
        --port="$PRIMARY_PORT" \
        --username="$REPL_USER" \
        --pgdata="$PGDATA" \
        --format=plain \
        --wal-method=stream \
        --slot="$SLOT_NAME" \
        --write-recovery-conf \
        --progress; do
    echo "[replica] primary not accepting replication connections yet, retrying in 2s..."
    # pg_basebackup ปฏิเสธ target ที่ไม่ว่าง → ล้างของที่ค้างก่อนลองใหม่
    find "$PGDATA" -mindepth 1 -delete
    sleep 2
  done

  # PostgreSQL ไม่ยอม start ถ้า data dir เปิดสิทธิ์ให้ group/other
  chmod 0700 "$PGDATA"
  echo "[replica] base backup complete; standby.signal written:"
  ls -1 "$PGDATA/standby.signal"
  grep -E 'primary_conninfo|primary_slot_name' "$PGDATA/postgresql.auto.conf" || true
else
  echo "[replica] existing data directory found, skipping base backup"
fi

# ส่งต่อให้ entrypoint มาตรฐาน เพื่อให้มัน setup permission/env และ drop privilege
# "$@" คือ `command:` จาก compose (hot_standby=on ฯลฯ)
exec docker-entrypoint.sh postgres "$@"
