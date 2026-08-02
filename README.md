# Shopee-lite — microservices + Kafka + API gateway + PostgreSQL

A deliberately small event-driven system you can run with one command. Four NestJS
services, one API gateway, Kafka for events between services, PostgreSQL for state.

```
                        ┌──────────────────────────────┐
   client ─────────────▶│  api-gateway  :3000          │  only public port
                        │  /api/* → routing table      │
                        └───┬──────┬──────┬──────┬─────┘
                       HTTP │      │      │      │
         ┌──────────────────▼┐ ┌───▼─────┐│ ┌────▼───────────┐
         │ user-service      │ │ order-  ││ │ notification-  │
         │ :3001             │ │ service ││ │ service :3004  │
         │ users_db          │ │ :3002   ││ │ notifications_db│
         └────────┬──────────┘ │orders_db││ └────────┬───────┘
                  │            └──┬──────┘│          │
                  │               │  ┌────▼──────────▼──┐
                  │               │  │ inventory-service│
                  │               │  │ :3003            │
                  │               │  │ inventory_db     │
                  │               │  └────────┬─────────┘
                  │               │           │
              ┌───▼───────────────▼───────────▼──────────────┐
              │            Kafka  (events)                   │
              │  user.created  order.created  order.confirmed│
              │  order.cancelled  inventory.reserved/rejected│
              └──────────────────────────────────────────────┘
```

## Why it is wired this way

You asked what other platforms do — this is the mainstream pattern:

- **Gateway talks HTTP to services.** A user clicking "Buy" is waiting for an answer,
  so the request path is synchronous. Gateways (Kong, Spring Cloud Gateway, Nginx,
  Envoy, AWS API Gateway) are HTTP reverse proxies, not Kafka clients. Putting Kafka
  on the request path means inventing request/reply over topics — slow and awkward.
- **Services talk to each other over Kafka.** "An order was placed" is a fact that
  three services care about. Publishing it once, and letting each consumer react at
  its own pace, means order-service does not need to know that notification-service
  exists. That is the actual win of Kafka — not speed, decoupling.
- **One exception: order-service calls user-service and inventory-service over HTTP**
  to validate the user and read the current price at checkout. Needing a value *right
  now* is a query, and queries are synchronous. Events are for facts.
- **Database per service.** Each service owns its own database and nobody else can
  read it. One Postgres container with four databases here (cheap for a demo); in
  production it would be four separate instances. No cross-service joins, ever.
- **Everything containerised.** Since you haven't done this before, `docker compose up`
  beats a page of setup instructions. Kafka runs in KRaft mode — no ZooKeeper, which
  older tutorials still tell you to install.

## Run it

```bash
docker compose up --build      # first run pulls images + builds 5 node images (~3-5 min)
```

| URL | What |
| --- | --- |
| http://localhost:3000 | API gateway — the only entrypoint you need |
| http://localhost:3000/health | Health of all four services in one call |
| http://localhost:8080 | Kafka UI — browse topics and messages |
| localhost:5432 | Postgres (`postgres` / `postgres`) |
| localhost:29092 | Kafka, from your machine |

Then run the demo (creates a user, a happy-path order, and a rejected order):

```powershell
.\scripts\demo.ps1        # Windows
```
```bash
./scripts/demo.sh         # macOS/Linux, needs jq
```

Watch it happen live in another terminal:

```bash
docker compose logs -f order-service inventory-service notification-service
```

## The flow that matters

`POST /api/orders` returns in milliseconds with status `PENDING`. Everything after
that is asynchronous:

1. **order-service** validates the user + product over HTTP, saves the order as
   `PENDING`, publishes `order.created`.
2. **inventory-service** consumes it, and in one Postgres transaction with a row lock
   either reserves stock → `inventory.reserved`, or refuses → `inventory.rejected`.
3. **order-service** consumes that answer and moves the order to `CONFIRMED` or
   `CANCELLED`, publishing `order.confirmed` / `order.cancelled`.
4. **user-service** consumes `order.confirmed` to update its own `ordersCount` /
   `totalSpent` read model.
5. **notification-service** consumes everything and writes a notification row.
6. If an order is cancelled after stock was reserved, inventory-service consumes
   `order.cancelled` and puts the stock back — a **compensating transaction**. This is
   the saga pattern: there are no distributed transactions, only undo steps.

Poll `GET /api/orders/{id}` a second later and you'll see `PENDING → CONFIRMED`.

## API (all through the gateway on :3000)

```http
POST   /api/users              { "email": "ada@example.com", "name": "Ada" }
GET    /api/users
GET    /api/users/{id}

GET    /api/products
POST   /api/products           { "sku": "X-1", "name": "Thing", "price": 9.99, "stock": 5 }
PATCH  /api/products/{id}/restock   { "quantity": 10 }

POST   /api/orders             { "userId": "...", "productId": "...", "quantity": 2 }
GET    /api/orders?userId=...
GET    /api/orders/{id}

GET    /api/notifications?userId=...
```

Seeded products include `LIMITED-01` with a stock of 2 — order 5 of them to see the
rejection + cancellation path.

## Topics

| Topic | Published by | Consumed by |
| --- | --- | --- |
| `user.created` | user-service | notification-service |
| `order.created` | order-service | inventory-service, notification-service |
| `inventory.reserved` | inventory-service | order-service |
| `inventory.rejected` | inventory-service | order-service, notification-service |
| `order.confirmed` | order-service | user-service, notification-service |
| `order.cancelled` | order-service | inventory-service, notification-service |

Message keys are the order id (or user id), so all events about one order land on the
same partition and are therefore processed in order. Each service uses its own
consumer group, so each service gets its own copy of every event.

## Working on one service locally

```bash
docker compose up postgres kafka kafka-ui     # infra only
cd services/order-service
npm install
npm run start:dev                             # uses localhost:29092 by default
```

## Things worth knowing (the traps)

- **`emit()` is a cold observable.** In NestJS, `client.emit(topic, payload)` sends
  nothing unless you subscribe or await it. Every publish in this repo is `await
  firstValueFrom(...)` for that reason.
- **Kafka is at-least-once, not exactly-once.** Events can be delivered twice after a
  rebalance or redeploy. Consumers must be idempotent. Here: order-service ignores
  events for orders that already left `PENDING`, and inventory-service keeps a
  `reservations` table keyed by `orderId`.
- **`synchronize: true` in TypeORM is for demos.** It rewrites your schema on boot.
  Real projects use generated migrations.
- **Two listeners on Kafka.** `kafka:9092` works inside the Docker network,
  `localhost:29092` works from your machine. Using the wrong one is the most common
  "connection refused".
- **A crashed consumer is not a lost event.** Stop notification-service, place orders,
  start it again — it resumes from its committed offset and processes the backlog.
  That durability is the reason to use Kafka over an in-memory bus.

## Next steps to learn from

1. Add a `payment-service` that consumes `order.confirmed` and publishes
   `payment.failed` — then handle it in order-service to trigger the cancellation
   path. You should not need to touch inventory-service at all.
2. Add JWT auth in the gateway (`@nestjs/passport`) so `/api/orders` requires a token
   and the `userId` comes from the token instead of the body.
3. Give a topic 3 partitions and run `docker compose up --scale inventory-service=3`.
   Watch the consumer group rebalance in Kafka UI.
4. Add a dead-letter topic: catch failures in a consumer and publish to
   `order.created.dlq` instead of retrying forever.
5. Replace `synchronize: true` with TypeORM migrations.

## Layout

```
docker-compose.yml            infra + all five services
infra/postgres/init.sql       creates the four databases
scripts/demo.ps1 | .sh        end-to-end walkthrough
services/api-gateway/         routing table + proxy handler
services/user-service/        users, publishes user.created
services/order-service/       the saga coordinator
services/inventory-service/   stock reservation + compensation
services/notification-service/ pure consumer, no write API
```

Each service is standalone: its own `package.json`, its own `Dockerfile`, its own
database. `src/events/contracts.ts` is duplicated in each service on purpose — in
production that file becomes a shared package or a schema registry.
