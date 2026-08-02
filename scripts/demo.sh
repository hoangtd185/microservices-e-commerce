#!/usr/bin/env bash
# End-to-end walkthrough against the gateway. Needs curl + jq.
set -euo pipefail
GW=${GW:-http://localhost:3000}

post() { curl -sS -X POST "$GW$1" -H 'content-type: application/json' -d "$2"; }

echo "== health =="
curl -sS "$GW/health" | jq -c '.services[] | {service, status}'

echo
echo "== 1. create a user =="
USER_JSON=$(post /api/users "{\"email\":\"ada+$RANDOM@example.com\",\"name\":\"Ada Lovelace\"}")
USER_ID=$(echo "$USER_JSON" | jq -r .id)
echo "user  : $USER_ID"

echo
echo "== 2. catalog =="
PRODUCTS=$(curl -sS "$GW/api/products")
echo "$(echo "$PRODUCTS" | jq 'length') products seeded. The scarce ones:"
echo "$PRODUCTS" | jq -c '.[] | select(.sku | startswith("FLASH-") or startswith("LIMITED-")) | {sku, price, stock}'
PHONE_ID=$(echo "$PRODUCTS" | jq -r '.[] | select(.sku=="PHONE-001") | .id')
LIMITED_ID=$(echo "$PRODUCTS" | jq -r '.[] | select(.sku=="LIMITED-01") | .id')

echo
echo "== 3. happy path: 2 x PHONE-001 (returns immediately, PENDING) =="
post /api/orders "{\"userId\":\"$USER_ID\",\"productId\":\"$PHONE_ID\",\"quantity\":2}" |
  jq -c '{id, status, totalPrice}'

echo
echo "== 4. failure path: 5 x LIMITED-01 (stock is 2) =="
BAD_ID=$(post /api/orders "{\"userId\":\"$USER_ID\",\"productId\":\"$LIMITED_ID\",\"quantity\":5}" | jq -r .id)
echo "order : $BAD_ID"

echo
echo "== 5. idempotency: the same request sent twice =="
KEY=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
BODY="{\"userId\":\"$USER_ID\",\"productId\":\"$PHONE_ID\",\"quantity\":1}"
idem() {
  curl -sS -X POST "$GW/api/orders" -H 'content-type: application/json' \
    -H "Idempotency-Key: $KEY" -d "$BODY"
}
FIRST=$(idem | jq -r .id)
SECOND=$(idem | jq -r .id)
echo "1st call : $FIRST"
echo "2nd call : $SECOND"
[ "$FIRST" = "$SECOND" ] && echo "  same order id -> one purchase, not two" \
                         || echo "  DIFFERENT order ids -> idempotency is not working"

echo
echo "   waiting 3s for Kafka to carry the events around..."
sleep 3

echo "== 6. orders after the saga finished =="
curl -sS "$GW/api/orders?userId=$USER_ID" | jq -c '.[] | {quantity, status, statusReason}'

echo
echo "== 7. why inventory decided that =="
curl -sS "$GW/api/reservations/$BAD_ID" | jq -c '{quantity, status, reason}'

echo
echo "== 8. user read model, rebuilt from order.confirmed =="
curl -sS "$GW/api/users/$USER_ID" | jq -c '{name, ordersCount, totalSpent}'

echo
echo "== 9. stock after reservation =="
curl -sS "$GW/api/products" | jq -c --arg p "$PHONE_ID" --arg l "$LIMITED_ID" \
  '.[] | select(.id == $p or .id == $l) | {sku, stock, reserved}'

echo
echo "== 10. notifications produced by consuming events =="
curl -sS "$GW/api/notifications?userId=$USER_ID" | jq -c '.[] | {topic, channel, message}'

echo
echo "Open http://localhost:8080 to see these messages sitting in Kafka."
