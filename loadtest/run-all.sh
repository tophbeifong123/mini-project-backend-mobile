#!/usr/bin/env bash
# =============================================================================
# Automated All-in-One k6 Load Test Runner (Bash / Linux / WSL)
# Usage:
#   bash loadtest/run-all.sh [BASE_URL]
# =============================================================================

set -e

BASE_URL="${1:-http://localhost:8080}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"

mkdir -p "$RESULTS_DIR"

echo "===================================================================="
echo " 🚀 STARTING ALL-IN-ONE FLASH SALE LOAD TESTS (4 TESTS)"
echo " Target URL : $BASE_URL"
echo " Output Dir : $RESULTS_DIR"
echo "===================================================================="

TESTS=(
  "loadtest.js:summary_01_loadtest.json:Main Deliverable (loadtest.js)"
  "loadtest/flash-sale.js:summary_02_flash-sale.json:Comprehensive Cache (loadtest/flash-sale.js)"
  "loadtest/test_by_ao/testBuyAo_n.js:summary_03_testBuyAo_n.json:Normal Workload (testBuyAo_n.js)"
  "loadtest/test_by_ao/testBuyAo_f.js:summary_04_testBuyAo_f.json:Max Ramping (testBuyAo_f.js)"
)

for item in "${TESTS[@]}"; do
  IFS=":" read -r script_file out_json desc <<< "$item"
  echo ""
  echo "--------------------------------------------------------------------"
  echo " RUNNING: $desc"
  echo "--------------------------------------------------------------------"

  echo "🔄 [1/4] Resetting Database & Redis Stock..."
  RESET_CONFIRM=yes pnpm run reset

  echo "🧹 [2/4] Clearing Metrics Counters..."
  curl -s -u admin:admin -X POST "$BASE_URL/admin/metrics/reset" >/dev/null 2>&1 || true

  sleep 2

  echo "⚡ [3/4] Executing k6 ($script_file)..."
  k6 run --env BASE_URL="$BASE_URL" --summary-export="$RESULTS_DIR/$out_json" "$ROOT_DIR/$script_file"

  echo "🛡️ [4/4] Verifying Data Integrity..."
  podman exec fs-postgres-primary psql -U flashsale -d flashsale -c "SELECT id, remaining_stock, available_stock FROM products WHERE id = 'p-1001';" || true
  podman exec fs-postgres-primary psql -U flashsale -d flashsale -c "SELECT count(*) as orders_count, count(distinct user_id) as unique_users FROM orders WHERE product_id = 'p-1001';" || true
  echo "Redis counter: $(podman exec fs-redis-data redis-cli GET stock:flash_sale:p-1001 || true)"

  sleep 3
done

echo ""
echo "===================================================================="
echo " 🏁 ALL 4 LOAD TESTS COMPLETED!"
echo " Reports saved in: $RESULTS_DIR"
echo "===================================================================="
