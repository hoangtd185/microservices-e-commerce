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
PUBLIC
POST   /api/auth/register      { "email": "ada@example.com", "name": "Ada", "password": "..." }
POST   /api/auth/login         { "email": "ada@example.com", "password": "..." }
GET    /api/products

AUTHENTICATED   (header: Authorization: Bearer <token>)
GET    /api/users/{id}
POST   /api/products           { "sku": "X-1", "name": "Thing", "price": 9.99, "stock": 5 }
PATCH  /api/products/{id}/restock   { "quantity": 10 }

POST   /api/orders             { "productId": "...", "quantity": 2 }
       header: Idempotency-Key: <uuid>       (optional, strongly recommended)
GET    /api/orders                    only your own
GET    /api/orders/{id}               404 if it is not yours
GET    /api/reservations/{orderId}    what inventory decided, and why
GET    /api/notifications?userId=...
```

Note what is missing from `POST /api/orders`: **`userId`**. Identity comes from the
token, never from the body. A field the client controls can never be an identity.

The seeded catalog is 100 products. `LIMITED-01` (stock 2) and the `FLASH-*` SKUs are
deliberately scarce — order 5 of `LIMITED-01` to see the rejection + cancellation path.
`FLASH-100` holds 100 units and exists as a load-test target.

## Auth: JWT at the gateway

user-service **signs** tokens, the gateway **verifies** them, and services never parse a
JWT at all. After verification the gateway forwards the proven identity downstream as
plain headers:

```
Authorization: Bearer <jwt>   →   gateway verifies   →   x-user-id: <uuid>
                                                          x-user-email: ...
```

Three details that matter more than the code:

1. **Deny by default.** Everything under `/api` needs a token except an explicit list
   (`register`, `login`, `GET /products`). Forget to list a new route and it is merely
   locked, never accidentally public.
2. **The gateway deletes any `x-user-*` header the client sent**, before routing.
   Without that line, anyone can add `x-user-id: <victim>` and become that person.
   There is a test for exactly this attack.
3. **Authentication ≠ authorisation.** A valid token proves who you are, not that a
   given order is yours. `GET /api/orders/{id}` returns 404 — not 403 — for someone
   else's order, so the response does not confirm that the id exists.

Passwords use **scrypt** from Node's standard library (memory-hard, no native module to
compile), stored as `salt:hash`, compared in constant time, and the column is
`select: false` so it cannot leak into a response by accident. Argon2id is the modern
first choice if you want to swap it.

Login returns the same error for "no such email" and "wrong password" — different
messages let an attacker enumerate which accounts exist.

## Correctness: the two things that stop double-charging

**Idempotency keys (order-service).** Send `Idempotency-Key: <uuid>` with `POST /api/orders`
and a retry returns the *same* order instead of creating a second one:

```powershell
$key = [guid]::NewGuid().ToString()
# send this twice - one order, and the second response carries Idempotent-Replay: true
```

The key row and the order are written in **one transaction**, so either both exist or
neither does. A concurrent duplicate blocks on the primary-key index until the first
commits, so a double-clicked Buy button is resolved by Postgres rather than by a race in
JavaScript. Reusing a key with a different body returns 422 — that's a client bug worth
surfacing, not hiding. The gateway forwards the header; forgetting that is the classic
way to make idempotency silently stop working.

**Atomic conditional UPDATE (inventory-service).** Stock is decremented with one statement:

```sql
UPDATE products SET stock = stock - $1, reserved = reserved + $1
 WHERE id = $2 AND stock >= $1
RETURNING stock;
```

Zero rows affected means insufficient stock. No `SELECT ... FOR UPDATE` held across
statements, no version column, no retry loop. When two requests race for the last items,
the second one blocks only for the duration of that single statement, then re-evaluates
`stock >= $1` against the committed row and correctly matches nothing.

Why not the alternatives:

| | Behaviour under a flash sale |
| --- | --- |
| Optimistic (version column) | Most requests conflict and retry, retries conflict again — retry storm |
| Pessimistic (`FOR UPDATE`) | Correct, but serialises on the row for the whole transaction; the connection pool dies first |
| **Atomic conditional UPDATE** | One statement, no lock held across round trips, no retries |

The `reservations` table doubles as the idempotency record for inventory: `orderId` is the
primary key, so a redelivered `order.created` cannot decrement stock twice.

## The transactional outbox

**No service ever calls Kafka from its business logic.** Look for `kafka.emit` in
order-service or inventory-service — it isn't there.

The problem: a service cannot atomically write to Postgres *and* publish to Kafka. Two
systems, two commits, no shared transaction. Crash in between and you get an order that
exists but that nobody was ever told about.

The fix: don't publish. Write the event into an `outbox` table **inside the same
transaction** as the business data. One commit, one system, atomic. A relay reads the
table afterwards and publishes.

```ts
await this.dataSource.transaction(async (manager) => {
  const order = await manager.save(manager.create(Order, draft));
  await manager.update(IdempotencyKey, { key }, { orderId: order.id });
  await this.outbox.record(manager, { topic: 'order.created', key: order.id, payload });
});
// no broker call anywhere in the request path
```

Two things this buys beyond correctness:

- **The request got faster.** A broker round trip left the hot path entirely; all that
  remains is one extra INSERT into an already-open transaction.
- **A workaround disappeared.** inventory-service used to replay a stored outcome on
  redelivery, purely to paper over the crash-between-commit-and-publish gap. With an
  outbox the gap doesn't exist, so that code is gone.

**Transaction discipline in the relay** — nothing slow ever runs inside a transaction:

| Step | Transaction? |
| --- | --- |
| Claim a batch (`FOR UPDATE SKIP LOCKED`, sets a lease) | one statement |
| Publish to Kafka | **none open** |
| Mark published | one statement |

`SKIP LOCKED` means several relay instances can share the table without blocking or
double-sending. If a relay dies mid-publish, the lease expires after 30s and another
pass retries — at-least-once, which is what Kafka gives you anyway, so consumers already
cope.

The relay polls here to keep the stack small. Production usually swaps it for
change-data-capture (Debezium tailing the Postgres WAL), which removes polling entirely
— but the contract is identical, so the business code never changes.

```sql
-- watch it work
SELECT id, topic, "publishedAt" FROM outbox ORDER BY id DESC LIMIT 10;
SELECT count(*) FROM outbox WHERE "publishedAt" IS NULL;   -- backlog; should sit at 0
```

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

## Tests

No test framework to install — Node 18+ has `fetch` built in, and the harness is
~200 lines. The stack must be running.

```bash
docker compose up -d
npm test          # 36 e2e tests through the gateway
npm run test:load # concurrency / oversell tests
```

Everything runs against **real Postgres and real Kafka** through the gateway on :3000,
because that is the only way to catch the bugs that actually happen here. The worst bug
found in this project so far — TypeORM returning `[rows, rowCount]` for a raw `UPDATE`,
so a success was read as "out of stock" — is invisible to a unit test with a mocked
repository. It fails loudly in an e2e test.

Each test mints its own user and its own product, so runs never interfere with each
other and you never need to reset between runs.

The concurrency suite oversubscribes one product and asserts three invariants:

1. stock never goes negative
2. confirmed units never exceed the stock that existed at the start
3. `stock + reserved` is conserved — nothing created, nothing lost

Invariant 3 is the strict one: a lost-update bug (read, modify in JS, write back) breaks
it even when the first two happen to look fine.

```bash
ORDERS=500 QTY=1 STOCK=200 node tests/concurrency.test.js   # turn up the pressure
SKU=FLASH-100 node tests/concurrency.test.js                # hammer a seeded SKU instead
```

## Seeding

The catalog is generated deterministically, so every run produces the same 100 SKUs.
Seeding runs automatically on boot (`SEED_PRODUCTS=true`) and never touches the stock of
SKUs that already exist. To re-run it by hand, or to reset stock between load tests:

```bash
docker compose exec inventory-service node dist/seed/seed.js
docker compose exec inventory-service node dist/seed/seed.js --reset-stock
```

Locally: `cd services/inventory-service && npm run seed -- --reset-stock`.

It's a single `INSERT ... ON CONFLICT` rather than a read-then-write loop — the same
reasoning as the stock decrement.

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
- **TypeORM's raw `UPDATE` returns a different shape.** `manager.query()` returns
  `raw.rows` for most statements, but for `UPDATE` and `DELETE` it returns
  `[rows, rowCount]`. So `result.length` is always 2 and a check like
  `result.length === 1` silently never matches. Every conditional update here is
  wrapped in a CTE (`WITH x AS (UPDATE ... RETURNING ...) SELECT * FROM x`) so the
  outer command is a `SELECT` and the result shape is unambiguous — still one
  atomic statement.
- **`synchronize: true` in TypeORM is for demos.** It rewrites your schema on boot.
  Real projects use generated migrations.
- **Two listeners on Kafka.** `kafka:9092` works inside the Docker network,
  `localhost:29092` works from your machine. Using the wrong one is the most common
  "connection refused".
- **A crashed consumer is not a lost event.** Stop notification-service, place orders,
  start it again — it resumes from its committed offset and processes the backlog.
  That durability is the reason to use Kafka over an in-memory bus.

## Known gaps (deliberate, and worth fixing next)

- **No dead-letter topic.** A consumer that keeps throwing blocks its partition forever.
  Retry N times, then publish to `<topic>.dlq` and move on.
- **Reservations expire but nothing reaps them.** `expiresAt` is recorded so abandoned
  checkouts can be released, but the reaper needs a matching cancellation event to keep
  order-service in step — a good exercise.
- **No refresh tokens.** Access tokens last an hour and there is no rotation or
  revocation. Real auth needs a refresh flow and a way to kill a session.
- **Symmetric JWT signing.** Gateway and user-service share one secret, so the gateway
  *could* mint tokens. RS256 splits that: only user-service holds the private key.
- **No distributed tracing.** One request crosses four services and you cannot see it as
  a single timeline. OpenTelemetry + Jaeger is the highest-value thing left.
- **`synchronize: true`** still rewrites the schema on boot. Migrations before production.

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
tests/e2e.test.js             36 tests through the gateway
tests/concurrency.test.js     oversell / lost-update invariants
tests/lib/harness.js          tiny zero-dependency test runner
services/api-gateway/         routing table + proxy handler
services/user-service/        users, publishes user.created
services/order-service/       the saga coordinator
services/inventory-service/   stock reservation + compensation
services/notification-service/ pure consumer, no write API
```

Each service is standalone: its own `package.json`, its own `Dockerfile`, its own
database. `src/events/contracts.ts` is duplicated in each service on purpose — in
production that file becomes a shared package or a schema registry.
