#!/bin/bash
# =============================================================================
# postgres-primary init (รันครั้งเดียวตอน data dir ว่าง โดย docker-entrypoint)
#   1) สร้าง role สำหรับ streaming replication
#   2) สร้าง physical replication slot (กัน WAL ถูกลบก่อน replica ตามทัน)
#   3) เปิด pg_hba ให้ replica เชื่อมเข้ามาได้
# =============================================================================
set -e

REPL_USER="${POSTGRES_REPLICATION_USER:-replicator}"
REPL_PASS="${POSTGRES_REPLICATION_PASSWORD:-replpass}"
SLOT_NAME="${REPLICATION_SLOT_NAME:-replica_1_slot}"

echo "[primary-init] creating replication role '${REPL_USER}'"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE ROLE "${REPL_USER}" WITH REPLICATION LOGIN PASSWORD '${REPL_PASS}';
EOSQL

echo "[primary-init] creating physical replication slot '${SLOT_NAME}'"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
SELECT pg_create_physical_replication_slot('${SLOT_NAME}');
EOSQL

echo "[primary-init] appending replication rules to pg_hba.conf"
cat >> "$PGDATA/pg_hba.conf" <<EOHBA

# --- streaming replication (added by primary-init.sh) ---
host    replication    ${REPL_USER}    0.0.0.0/0    scram-sha-256
host    replication    ${REPL_USER}    ::/0         scram-sha-256
EOHBA

echo "[primary-init] done"
