'use strict';

/**
 * Concurrency test: the one that proves the atomic UPDATE actually works.
 *
 *   docker compose up -d
 *   node tests/concurrency.test.js            # defaults: 200 orders, 2 units each
 *   ORDERS=500 QTY=1 node tests/concurrency.test.js
 *
 * We deliberately oversubscribe a single product: far more demand than stock,
 * all arriving at once, all hitting the same database row. Three invariants
 * must hold no matter how the requests interleave:
 *
 *   1. stock never goes negative
 *   2. confirmed units never exceed the stock that existed at the start
 *   3. stock + reserved stays constant (nothing created, nothing lost)
 *
 * Invariant 3 is the strict one. A lost-update bug (read, modify in JS, write
 * back) breaks it even when 1 and 2 happen to look fine.
 */

const {
  api,
  assert,
  describe,
  it,
  run,
  waitFor,
  createUser,
  createProduct,
  getProductBySku,
  colors: { dim, bold },
} = require('./lib/harness');

const ORDERS = Number(process.env.ORDERS || 200);
const QTY = Number(process.env.QTY || 2);
const STOCK = Number(process.env.STOCK || 100);
// By default the test mints its own product, so it is repeatable with no
// cleanup. Point it at a seeded SKU (SKU=FLASH-100) to hammer that row instead.
const SKU = process.env.SKU || null;

/** Wait until no order for this product is still PENDING. */
async function waitForSagaToSettle(orderIds, timeoutMs) {
  return waitFor(
    `${orderIds.length} orders to settle`,
    async () => {
      const results = await Promise.all(
        orderIds.map(async (id) => (await api.get(`/api/orders/${id}`)).body),
      );
      const pending = results.filter((o) => o && o.status === 'PENDING');
      return pending.length === 0 ? results : null;
    },
    { timeoutMs, intervalMs: 500 },
  );
}

describe(
  `Concurrency - ${ORDERS} simultaneous orders of ${QTY} unit(s)` +
    (SKU ? ` against ${SKU}` : ` against a fresh product (stock ${STOCK})`),
  () => {
  it('never oversells, never loses stock', async () => {
    const user = await createUser('load');
    const before = SKU
      ? await getProductBySku(SKU)
      : await createProduct({ stock: STOCK, price: 9.99, label: 'load' });

    const demand = ORDERS * QTY;
    console.log(
      dim(
        `      stock=${before.stock} reserved=${before.reserved} | demand=${demand} units ` +
          `(${(demand / Math.max(before.stock, 1)).toFixed(1)}x oversubscribed)`,
      ),
    );

    // Fire everything at once. No await inside the loop - that would serialise
    // the requests and quietly test nothing.
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: ORDERS }, () =>
        api.post('/api/orders', {
          userId: user.id,
          productId: before.id,
          quantity: QTY,
        }),
      ),
    );
    const postMs = Date.now() - started;

    const accepted = responses.filter((r) => r.status === 201);
    const rejectedUpFront = responses.filter((r) => r.status !== 201);

    console.log(
      dim(
        `      ${accepted.length} accepted, ${rejectedUpFront.length} failed at POST ` +
          `in ${postMs}ms (${Math.round((ORDERS / postMs) * 1000)} req/s)`,
      ),
    );

    assert.equal(
      rejectedUpFront.length,
      0,
      `every POST should be accepted as PENDING; got failures like ${JSON.stringify(rejectedUpFront[0]?.body)}`,
    );

    // Now let the saga finish. This is where the real work happens.
    const settleStarted = Date.now();
    const orders = await waitForSagaToSettle(
      accepted.map((r) => r.body.id),
      Math.max(30000, ORDERS * 200),
    );
    const settleMs = Date.now() - settleStarted;

    const confirmed = orders.filter((o) => o.status === 'CONFIRMED');
    const cancelled = orders.filter((o) => o.status === 'CANCELLED');
    const after = await getProductBySku(before.sku);

    console.log(
      dim(
        `      settled in ${settleMs}ms: ${confirmed.length} CONFIRMED, ${cancelled.length} CANCELLED`,
      ),
    );
    console.log(dim(`      after: stock=${after.stock} reserved=${after.reserved}`));

    // --- invariant 1 ---
    assert.ok(after.stock >= 0, `stock went negative: ${after.stock}`);

    // --- invariant 2: this is the oversell check ---
    const soldUnits = confirmed.length * QTY;
    assert.atMost(
      soldUnits,
      before.stock,
      `OVERSOLD: confirmed ${soldUnits} units but only ${before.stock} existed`,
    );

    // --- invariant 3: conservation of inventory ---
    assert.equal(
      after.stock + after.reserved,
      before.stock + before.reserved,
      'stock + reserved must be conserved (a lost update would break this)',
    );

    // --- the arithmetic must also tie out exactly ---
    assert.equal(
      after.stock,
      before.stock - soldUnits,
      'stock should have dropped by exactly the confirmed units',
    );
    assert.equal(
      after.reserved,
      before.reserved + soldUnits,
      'reserved should have risen by exactly the confirmed units',
    );

    // --- and every loser must know why ---
    const badReason = cancelled.find((o) => !String(o.statusReason).includes('OUT_OF_STOCK'));
    assert.ok(
      !badReason,
      `every cancellation should say OUT_OF_STOCK, found: ${badReason?.statusReason}`,
    );
  });

  it('stays consistent when demand exactly equals supply', async () => {
    // The boundary case: every unit should sell, none should oversell.
    // Off-by-one bugs in the `stock >= qty` condition show up right here.
    const user = await createUser('exact');
    const start = await createProduct({ stock: 20, label: 'exact' });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        api.post('/api/orders', { userId: user.id, productId: start.id, quantity: 1 }),
      ),
    );

    const orders = await waitForSagaToSettle(
      responses.map((r) => r.body.id),
      30000,
    );
    const confirmed = orders.filter((o) => o.status === 'CONFIRMED');
    const after = await getProductBySku(start.sku);

    console.log(dim(`      ${confirmed.length}/20 confirmed, stock left ${after.stock}`));

    assert.equal(confirmed.length, 20, 'demand == supply, so every order should succeed');
    assert.equal(after.stock, 0, 'stock should land exactly on zero, never below');
    assert.equal(after.reserved, start.reserved + 20, 'all 20 units should be reserved');
  });
  },
);

if (SKU) {
  console.log(
    bold('\nTargeting a seeded SKU. Reset it between runs:') +
      dim('\n  docker compose exec inventory-service node dist/seed/seed.js --reset-stock\n'),
  );
}

run();
