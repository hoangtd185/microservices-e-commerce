# Cheatsheet

## Docker

```bash
docker compose up --build          # start everything
docker compose up -d --build       # ...in the background
docker compose ps                  # what is running
docker compose logs -f order-service
docker compose restart order-service
docker compose down                # stop
docker compose down -v             # stop AND wipe Postgres + Kafka data
docker compose up --build order-service   # rebuild one service after a code change
```

## Kafka (from inside the container)

```bash
# list topics
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list

# describe a topic (partitions, offsets)
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --describe --topic order.created

# tail every message on a topic from the beginning
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic order.created --from-beginning

# consumer groups and how far behind they are (LAG is the number to watch)
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --describe --all-groups
```

Or just open http://localhost:8080 (Kafka UI) and click around.

## Postgres

```bash
docker compose exec postgres psql -U postgres -l              # list databases
docker compose exec postgres psql -U postgres -d orders_db -c "select id, status, quantity from orders;"
docker compose exec postgres psql -U postgres -d orders_db -c "select key, \"orderId\" from idempotency_keys;"
docker compose exec postgres psql -U postgres -d orders_db -c "select id, topic, \"publishedAt\" from outbox order by id desc limit 10;"
docker compose exec postgres psql -U postgres -d orders_db -c "select count(*) as backlog from outbox where \"publishedAt\" is null;"
docker compose exec postgres psql -U postgres -d inventory_db -c "select sku, stock, reserved from products where sku like 'FLASH%';"
docker compose exec postgres psql -U postgres -d inventory_db -c "select \"orderId\", status, reason from reservations;"
docker compose exec postgres psql -U postgres -d notifications_db -c "select topic, message from notifications order by \"createdAt\" desc limit 10;"
```

Note the double quotes around `"createdAt"` — TypeORM creates camelCase columns, and
unquoted identifiers in Postgres are folded to lowercase.

## Experiments worth running

**See the backlog replay.** Stop a consumer, generate events, start it again:

```bash
docker compose stop notification-service
./scripts/demo.sh                       # events pile up in Kafka
docker compose start notification-service
docker compose logs -f notification-service   # it catches up from its offset
```

**Watch a rebalance.** Auto-created topics get 3 partitions
(`KAFKA_CFG_NUM_PARTITIONS=3`), so three instances of one service can share the work:

```bash
# first comment out the "ports:" block of inventory-service in docker-compose.yml -
# three containers cannot all bind host port 3003
docker compose up -d --scale inventory-service=3
docker compose logs -f inventory-service
```

All three join the same consumer group (`inventory-service-group`), so each partition
is handed to exactly one of them — that is how you scale a Kafka consumer.

**Prove the atomic update holds.** Reset the load-test SKU, then fire concurrent orders
for more units than exist and count how many were confirmed:

```bash
docker compose exec inventory-service node dist/seed/seed.js --reset-stock
# FLASH-100 is back to 100 units - now oversubscribe it and check the totals
docker compose exec postgres psql -U postgres -d inventory_db \
  -c "select sku, stock, reserved from products where sku = 'FLASH-100';"
```

`stock + reserved` must always equal 100. If it doesn't, you have an overselling bug.

**Prove the outbox never loses an event.** Stop Kafka, place orders, restart it. The
orders are accepted and their events queue up in Postgres instead of vanishing:

```bash
docker compose stop kafka
# place an order through the gateway - it still returns 201
docker compose exec postgres psql -U postgres -d orders_db \
  -c "select count(*) from outbox where \"publishedAt\" is null;"   # backlog grows
docker compose start kafka
# a few seconds later the backlog drains to 0 and the orders reach CONFIRMED
```

That is the whole point: the broker being down is no longer a data-loss event.

**Get a token for manual curl-ing:**

```bash
TOKEN=$(curl -sS -X POST http://localhost:3000/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com","name":"Me","password":"a-long-enough-password"}' \
  | jq -r .accessToken)

curl -sS http://localhost:3000/api/orders -H "Authorization: Bearer $TOKEN" | jq
```

**Prove idempotency works.** Send the same key twice and compare order ids:

```bash
KEY=$(uuidgen)
for i in 1 2; do
  curl -sS -X POST http://localhost:3000/api/orders \
    -H 'content-type: application/json' -H "Idempotency-Key: $KEY" \
    -d '{"userId":"<uuid>","productId":"<uuid>","quantity":1}' | jq -r .id
done
```

Two identical ids = one purchase. Two different ids = the header isn't reaching
order-service, almost always because the gateway dropped it.

**Break the sync path.** Stop user-service and try to place an order — order-service
fails fast with 400 and no event is published. Compare that with stopping
inventory-service: the order is accepted as `PENDING` and just sits there until
inventory comes back. That difference *is* the difference between HTTP and Kafka.
