#!/usr/bin/env bash
# Block until the stack can actually serve the test suite, or fail.
#
# "Containers are running" is not enough: services connect to Kafka and
# Postgres after boot, and inventory seeds the catalog on startup. The e2e
# suite asserts on seeded products, so starting it early fails for reasons
# that have nothing to do with the code under test.
set -euo pipefail

GW=${GATEWAY_URL:-http://localhost:3000}
TIMEOUT=${WAIT_TIMEOUT_SECONDS:-240}
deadline=$((SECONDS + TIMEOUT))

until curl -fsS "$GW/health" 2>/dev/null | jq -e '.allUp == true' >/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "::error::services not healthy after ${TIMEOUT}s"
    curl -sS "$GW/health" || true
    exit 1
  fi
  echo "waiting for /health ..."
  sleep 3
done
echo "all services up"

until [ "$(curl -fsS "$GW/api/products" 2>/dev/null | jq 'length' 2>/dev/null || echo 0)" -ge 100 ]; do
  if (( SECONDS >= deadline )); then
    echo "::error::catalog not seeded after ${TIMEOUT}s"
    exit 1
  fi
  echo "waiting for the catalog seed ..."
  sleep 3
done
echo "catalog seeded - stack ready after ${SECONDS}s"
