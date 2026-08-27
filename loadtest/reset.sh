#!/usr/bin/env bash
# Reset all 20 products to seed defaults, clear orders, flush Redis.
# Works from: PowerShell (calls WSL bash), WSL, Git Bash, macOS, Linux
#
# Usage:
#   bash loadtest/reset.sh
#   POSTGRES_PASSWORD=other bash loadtest/reset.sh
#
# Requires: Node.js (already required by the project) for JSON parsing — no jq needed.

set -euo pipefail

DOCKER=""
for candidate in docker docker.exe; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" version >/dev/null 2>&1; then
    DOCKER="$candidate"
    break
  fi
done

if [ -z "$DOCKER" ]; then
  echo "ERROR: docker (or docker.exe) not found / not responding." >&2
  echo "  Is Docker Desktop running? Is WSL integration enabled?" >&2
  exit 1
fi

COMPOSE_CMD=("$DOCKER" "compose")

if ! "${COMPOSE_CMD[@]}" version >/dev/null 2>&1; then
  echo "ERROR: '$DOCKER compose' not working." >&2
  exit 1
fi

NODE_CMD=""
for candidate in node node.exe; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version >/dev/null 2>&1; then
    NODE_CMD="$candidate"
    break
  fi
done

if [ -z "$NODE_CMD" ]; then
  echo "ERROR: Node.js not found on PATH." >&2
  echo "  Install: choco install nodejs-lts (Windows) / brew install node (macOS) / use nvm" >&2
  exit 1
fi

: "${POSTGRES_USER:=app}"
: "${POSTGRES_PASSWORD:=app123}"
: "${POSTGRES_DB:=flashsale}"

PSQL_CMD=(
  "${COMPOSE_CMD[@]}" exec -T
  -e "PGPASSWORD=$POSTGRES_PASSWORD"
  postgres-primary
  psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_FILE="$SCRIPT_DIR/../products-seed.json"

mkdir -p "$SCRIPT_DIR/results"

if [ ! -f "$SEED_FILE" ]; then
  echo "ERROR: $SEED_FILE not found." >&2
  exit 1
fi

UPDATE_SQL=$("$NODE_CMD" -e "
  const fs = require('fs');
  const products = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const cases = products
    .map(p => \"WHEN '\" + p.productId + \"' THEN \" + p.availableStock)
    .join(' ');
  process.stdout.write(
    \"UPDATE products SET \\\"remainingStock\\\" = CASE \\\"productId\\\" \" +
    cases +
    \" END, \\\"availableStock\\\" = CASE \\\"productId\\\" \" +
    cases +
    \" END;\"
  );
" < "$SEED_FILE")

echo "Using: ${COMPOSE_CMD[*]}"
PRODUCT_COUNT=$("$NODE_CMD" -e "
  const fs = require('fs');
  const products = JSON.parse(fs.readFileSync(0, 'utf-8'));
  process.stdout.write(String(products.length));
" < "$SEED_FILE")
echo "Parsed $PRODUCT_COUNT products from $SEED_FILE"
echo "Resetting all $PRODUCT_COUNT products to seed defaults..."

echo "-> Updating stock for all products..."
"${PSQL_CMD[@]}" -c "$UPDATE_SQL"

echo "-> Truncating orders table..."
"${PSQL_CMD[@]}" -c 'TRUNCATE TABLE "orders";'

echo "-> Flushing Redis cache + counters..."
"${COMPOSE_CMD[@]}" exec -T redis redis-cli FLUSHDB > /dev/null

echo "-> Verifying reset..."
"${PSQL_CMD[@]}" -tA -c \
  "SELECT \"productId\" || ' | remaining=' || \"remainingStock\" || ' | available=' || \"availableStock\" \
   FROM products ORDER BY \"productId\";"

"${PSQL_CMD[@]}" -tA -c \
  "SELECT 'orders count: ' || count(*) FROM orders;"

echo "Reset complete. Ready for k6 run."
echo "  Run: k6 run --env BASE_URL=http://localhost --out json=loadtest/results/summary.json loadtest/flash-sale.js"
echo "  Then: bash loadtest/verify.sh"
