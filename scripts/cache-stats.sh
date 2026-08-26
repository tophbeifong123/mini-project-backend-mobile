#!/bin/sh
# Cache Hit / Miss Ratio — ตัวเลขที่โจทย์บังคับให้โชว์ในรายงาน (Flash Sale System §3)
#
# วิธีใช้:
#   ./scripts/cache-stats.sh reset      # ล้างสถิติ ก่อนเริ่มยิง k6
#   k6 run loadtest.js
#   ./scripts/cache-stats.sh            # อ่านผล -> เอาไปใส่รายงาน
#
# อ่านจาก redis-cache (:6379) เท่านั้น — redis-data (:6380) เก็บ stock/queue ไม่ใช่แคช
set -eu

HOST="${REDIS_CACHE_HOST:-127.0.0.1}"
PORT="${REDIS_CACHE_PORT:-6379}"

# ใช้ redis-cli ในเครื่องถ้ามี ไม่งั้นยิงผ่าน container
if command -v redis-cli >/dev/null 2>&1; then
  RCLI="redis-cli -h $HOST -p $PORT"
else
  RCLI="${CONTAINER_CLI:-podman} exec fs-redis-cache redis-cli"
fi

if [ "${1:-}" = "reset" ]; then
  $RCLI CONFIG RESETSTAT >/dev/null
  echo "cache stats reset — เริ่มยิง load test ได้เลย"
  exit 0
fi

STATS=$($RCLI INFO stats)
HITS=$(echo "$STATS"   | tr -d '\r' | awk -F: '/^keyspace_hits:/   {print $2}')
MISSES=$(echo "$STATS" | tr -d '\r' | awk -F: '/^keyspace_misses:/ {print $2}')
HITS=${HITS:-0}
MISSES=${MISSES:-0}
TOTAL=$((HITS + MISSES))

echo "keyspace_hits   : $HITS"
echo "keyspace_misses : $MISSES"
if [ "$TOTAL" -gt 0 ]; then
  awk -v h="$HITS" -v t="$TOTAL" 'BEGIN { printf "hit ratio       : %.2f%%  (เป้า >= 90%%)\n", (h/t)*100 }'
else
  echo "hit ratio       : n/a (ยังไม่มี traffic)"
fi
