#!/usr/bin/env bash
# Post-loadtest verification: SQL data integrity + Redis cache state.
# Prints a console report. No exit-code gating.
#
# Usage:
#   bash loadtest/verify.sh

set -uo pipefail

DOCKER=""
for candidate in docker docker.exe; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" version >/dev/null 2>&1; then
    DOCKER="$candidate"
    break
  fi
done

if [ -z "$DOCKER" ]; then
  echo "ERROR: docker (or docker.exe) not found." >&2
  exit 1
fi

COMPOSE_CMD=("$DOCKER" "compose")

: "${POSTGRES_USER:=app}"
: "${POSTGRES_PASSWORD:=app123}"
: "${POSTGRES_DB:=flashsale}"

PSQL_CMD=(
  "${COMPOSE_CMD[@]}" exec -T
  -e "PGPASSWORD=$POSTGRES_PASSWORD"
  postgres-primary
  psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
)

REDIS_CMD=("${COMPOSE_CMD[@]}" exec -T redis redis-cli)

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0

print_header() {
  echo ""
  echo -e "${CYAN}============================================================${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}============================================================${NC}"
}

check_pass() {
  echo -e "  ${GREEN}[PASS]${NC} $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

check_fail() {
  echo -e "  ${RED}[FAIL]${NC} $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

check_warn() {
  echo -e "  ${YELLOW}[WARN]${NC} $1"
}

print_header "1. Stock Integrity — All 20 Products"

echo ""
echo "  productId    | available | remaining | sold"
echo "  -------------|-----------|-----------|------"
"${PSQL_CMD[@]}" -tA -F'|' -c \
  "SELECT \"productId\", \"availableStock\", \"remainingStock\", (\"availableStock\" - \"remainingStock\") AS sold
   FROM products ORDER BY \"productId\";" \
  | while IFS='|' read -r pid avail rem sold; do
      printf "  %-12s | %-9s | %-9s | %s\n" "$pid" "$avail" "$rem" "$sold"
    done

NEGATIVE_COUNT=$("${PSQL_CMD[@]}" -tA -c \
  "SELECT COUNT(*) FROM products WHERE \"remainingStock\" < 0;")
if [ "$NEGATIVE_COUNT" = "0" ]; then
  check_pass "No product has negative remainingStock"
else
  check_fail "Found $NEGATIVE_COUNT product(s) with negative remainingStock"
fi

print_header "2. Non-Target Products — Stock Must Be Unchanged"

UNCHANGED_COUNT=$("${PSQL_CMD[@]}" -tA -c \
  "SELECT COUNT(*) FROM products WHERE \"productId\" != 'p-1001' AND \"remainingStock\" != \"availableStock\";")

if [ "$UNCHANGED_COUNT" = "0" ]; then
  check_pass "All 19 non-p-1001 products have remainingStock == availableStock"
else
  check_fail "$UNCHANGED_COUNT non-p-1001 product(s) were modified unexpectedly"
  "${PSQL_CMD[@]}" -tA -c \
    "SELECT \"productId\" || ' | remaining=' || \"remainingStock\" || ' | available=' || \"availableStock\"
     FROM products WHERE \"productId\" != 'p-1001' AND \"remainingStock\" != \"availableStock\";"
fi

print_header "3. p-1001 (Heavy Load Target)"

P1001_LINE=$("${PSQL_CMD[@]}" -tA -F'|' -c \
  "SELECT (\"availableStock\" - \"remainingStock\") AS sold, \"remainingStock\"
   FROM products WHERE \"productId\" = 'p-1001';")

P1001_SOLD=$(echo "$P1001_LINE" | cut -d'|' -f1)
P1001_REMAINING=$(echo "$P1001_LINE" | cut -d'|' -f2)

SUCCESS_P1001=$("${PSQL_CMD[@]}" -tA -c \
  "SELECT COUNT(*) FROM orders WHERE \"productId\" = 'p-1001' AND status = 'SUCCESS';")
UNIQUE_USERS=$("${PSQL_CMD[@]}" -tA -c \
  "SELECT COUNT(DISTINCT \"userId\") FROM orders WHERE \"productId\" = 'p-1001' AND status = 'SUCCESS';")
FAILED_P1001=$("${PSQL_CMD[@]}" -tA -c \
  "SELECT COUNT(*) FROM orders WHERE \"productId\" = 'p-1001' AND status = 'FAILED';")

echo ""
echo "  sold (DB)         : $P1001_SOLD"
echo "  remainingStock    : $P1001_REMAINING"
echo "  SUCCESS orders    : $SUCCESS_P1001"
echo "  unique users      : $UNIQUE_USERS"
echo "  FAILED orders     : $FAILED_P1001"
echo ""

if [ "$P1001_REMAINING" = "0" ]; then
  check_pass "p-1001 remainingStock = 0 (not oversold, not negative)"
else
  check_fail "p-1001 remainingStock = $P1001_REMAINING (expected 0)"
fi

if [ "$P1001_SOLD" = "$SUCCESS_P1001" ]; then
  check_pass "p-1001 sold ($P1001_SOLD) == SUCCESS orders ($SUCCESS_P1001)"
else
  check_fail "Mismatch: sold=$P1001_SOLD vs SUCCESS=$SUCCESS_P1001"
fi

if [ "$UNIQUE_USERS" = "$SUCCESS_P1001" ]; then
  check_pass "Each SUCCESS order belongs to a unique user (no duplicate lock bypass)"
else
  check_fail "Duplicate orders detected: SUCCESS=$SUCCESS_P1001 but unique users=$UNIQUE_USERS"
fi

EXPECTED_P1001=50
if [ "$SUCCESS_P1001" = "$EXPECTED_P1001" ]; then
  check_pass "Exactly $EXPECTED_P1001 SUCCESS orders for p-1001 (matches stock)"
else
  check_fail "Expected $EXPECTED_P1001 SUCCESS orders for p-1001, got $SUCCESS_P1001"
fi

print_header "4. Order Integrity — Global"

TOTAL_ORDERS=$("${PSQL_CMD[@]}" -tA -c "SELECT COUNT(*) FROM orders;")
TOTAL_SUCCESS=$("${PSQL_CMD[@]}" -tA -c "SELECT COUNT(*) FROM orders WHERE status = 'SUCCESS';")
TOTAL_FAILED=$("${PSQL_CMD[@]}" -tA -c "SELECT COUNT(*) FROM orders WHERE status = 'FAILED';")
TOTAL_DUPLICATES=$("${PSQL_CMD[@]}" -tA -c \
  "SELECT COUNT(*) FROM (SELECT \"userId\", \"productId\" FROM orders GROUP BY \"userId\", \"productId\" HAVING COUNT(*) > 1) sub;")

STOCK_DECREASED=$("${PSQL_CMD[@]}" -tA -c \
  "SELECT COALESCE(SUM(\"availableStock\" - \"remainingStock\"), 0) FROM products;")

echo ""
echo "  total orders        : $TOTAL_ORDERS"
echo "  SUCCESS orders      : $TOTAL_SUCCESS"
echo "  FAILED orders       : $TOTAL_FAILED"
echo "  duplicate pairs     : $TOTAL_DUPLICATES"
echo "  total stock sold    : $STOCK_DECREASED"
echo ""

if [ "$TOTAL_DUPLICATES" = "0" ]; then
  check_pass "No duplicate (userId, productId) pairs"
else
  check_fail "$TOTAL_DUPLICATES duplicate order pair(s) found (UNIQUE constraint failed)"
fi

if [ "$STOCK_DECREASED" = "$TOTAL_SUCCESS" ]; then
  check_pass "Stock decreased ($STOCK_DECREASED) matches SUCCESS orders ($TOTAL_SUCCESS)"
else
  check_fail "Mismatch: stock_decreased=$STOCK_DECREASED vs SUCCESS=$TOTAL_SUCCESS"
fi

print_header "5. Redis Cache State"

CACHE_STATS=$("${COMPOSE_CMD[@]}" exec -T nest-1 curl -s http://localhost:3000/api/v1/products/admin/cache-stats 2>/dev/null || echo "{}")

HITS=$(echo "$CACHE_STATS" | grep -o '"hits":[0-9]*' | cut -d':' -f2)
MISSES=$(echo "$CACHE_STATS" | grep -o '"misses":[0-9]*' | cut -d':' -f2)
RATIO=$(echo "$CACHE_STATS" | grep -o '"hitRatio":[0-9.]*' | cut -d':' -f2)
TOTAL_REQS=${HITS:-0}
TOTAL_REQS=$((TOTAL_REQS + ${MISSES:-0}))

TRACKED_KEYS=$("${REDIS_CMD[@]}" SMEMBERS cache:tracked:products | wc -l | tr -d ' ')

echo ""
echo "  cache hits         : ${HITS:-0}"
echo "  cache misses       : ${MISSES:-0}"
echo "  cache hit ratio    : ${RATIO:-0}"
echo "  tracked cache keys : $TRACKED_KEYS"
echo ""

if [ "${MISSES:-0}" -gt 0 ]; then
  RATIO_INT=$(awk "BEGIN { printf \"%.0f\", ${RATIO:-0} * 100 }")
  if [ "$RATIO_INT" -ge 70 ]; then
    check_pass "Cache hit ratio = ${RATIO} (>= 70%, considering overflow mix)"
  else
    check_warn "Cache hit ratio = ${RATIO} (< 70%, may indicate cache invalidation issue)"
  fi
else
  check_pass "Cache tracking active"
fi

print_header "6. Summary"

echo ""
echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "  ${RED}Failed: $FAIL_COUNT${NC}"
echo ""

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo -e "  ${GREEN}All data integrity checks passed.${NC}"
else
  echo -e "  ${RED}Some checks failed. Review the output above.${NC}"
fi

echo ""
