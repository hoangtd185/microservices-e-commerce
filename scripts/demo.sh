#!/usr/bin/env bash
# End-to-end walkthrough against the gateway. Needs curl + jq.
set -euo pipefail
GW=${GW:-http://localhost:3000}

post()  { curl -sS -X POST "$GW$1" -H 'content-type: application/json' -d "$2"; }
apost() { curl -sS -X POST "$GW$1" -H 'content-type: application/json' \
            -H "Authorization: Bearer $TOKEN" ${3:+-H "$3"} -d "$2"; }
aget()  { curl -sS "$GW$1" -H "Authorization: Bearer $TOKEN"; }

echo "== health =="
curl -sS "$GW/health" | jq -c '.services[] | {service, status}'

echo
echo "== 1. register (public route) =="
AUTH=$(post /api/auth/register \
  "{\"email\":\"ada+$RANDOM@example.com\",\"name\":\"Ada Lovelace\",\"password\":\"correct-horse-battery-staple\"}")
TOKEN=$(echo "$AUTH" | jq -r .accessToken)
USER_ID=$(echo "$AUTH" | jq -r .user.id)
echo "user  : $USER_ID"
echo "token : ${TOKEN:0:32}..."

echo
echo "== 2. no token = no entry =="
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$GW/api/orders")
echo "GET /api/orders without a token -> $CODE (expected 401)"

echo
echo "== 3. catalog (public) =="
PRODUCTS=$(curl -sS "$GW/api/products")
echo "$(echo "$PRODUCTS" | jq 'length') products seeded. The scarce ones:"
echo "$PRODUCTS" | jq -c '.[] | select(.sku | startswith("FLASH-") or startswith("LIMITED-")) | {sku, price, stock}'
PHONE_ID=$(echo "$PRODUCTS" | jq -r '.[] | select(.sku=="PHONE-001") | .id')
LIMITED_ID=$(echo "$PRODUCTS" | jq -r '.[] | select(.sku=="LIMITED-01") | .id')

echo
echo "== 4. happy path: 2 x PHONE-001 (no userId in the body - it comes from the token) =="
apost /api/orders "{\"productId\":\"$PHONE_ID\",\"quantity\":2}" | jq -c '{id, status, totalPrice}'

echo
echo "== 5. failure path: 5 x LIMITED-01 (stock is 2) =="
BAD_ID=$(apost /api/orders "{\"productId\":\"$LIMITED_ID\",\"quantity\":5}" | jq -r .id)
echo "order : $BAD_ID"

echo
echo "== 6. idempotency: the same request twice =="
KEY=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
BODY="{\"productId\":\"$PHONE_ID\",\"quantity\":1}"
FIRST=$(apost /api/orders "$BODY" "Idempotency-Key: $KEY" | jq -r .id)
SECOND=$(apost /api/orders "$BODY" "Idempotency-Key: $KEY" | jq -r .id)
echo "1st call : $FIRST"
echo "2nd call : $SECOND"
[ "$FIRST" = "$SECOND" ] && echo "  same order id -> one purchase, not two" \
                         || echo "  DIFFERENT order ids -> idempotency is not working"

echo
echo "   waiting 3s for the outbox relay + Kafka to carry the events..."
sleep 3

echo "== 7. orders after the saga finished =="
aget "/api/orders" | jq -c '.[] | {quantity, status, statusReason}'

echo
echo "== 8. why inventory decided that =="
aget "/api/reservations/$BAD_ID" | jq -c '{quantity, status, reason}'

echo
echo "== 9. user read model, rebuilt from order.confirmed =="
aget "/api/users/$USER_ID" | jq -c '{name, ordersCount, totalSpent}'

echo
echo "== 10. stock after reservation =="
curl -sS "$GW/api/products" | jq -c --arg p "$PHONE_ID" --arg l "$LIMITED_ID" \
  '.[] | select(.id == $p or .id == $l) | {sku, stock, reserved}'

echo
echo "== 11. notifications produced by consuming events =="
aget "/api/notifications?userId=$USER_ID" | jq -c '.[] | {topic, channel, message}'

echo
echo "Open http://localhost:8080 to see these messages sitting in Kafka."
