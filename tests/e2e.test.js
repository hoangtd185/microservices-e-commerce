'use strict';

/**
 * End-to-end tests against a running stack.
 *
 *   docker compose up -d
 *   node tests/e2e.test.js
 *
 * Everything goes through the gateway on :3000, exactly like a real client.
 * Real Postgres, real Kafka, real saga - which is the point: the class of bug
 * that hurts most here (wrong result shape from the DB driver, events not
 * published, stock going negative) is invisible to unit tests with mocks.
 */

const {
  api,
  assert,
  describe,
  it,
  run,
  waitFor,
  waitForOrderStatus,
  createUser,
  createProduct,
  getProductBySku,
  uuid,
} = require('./lib/harness');

// ---------------------------------------------------------------------------

describe('Gateway', () => {
  it('routes /api/* to the owning service', async () => {
    const res = await api.get('/api/products');
    assert.equal(res.status, 200, 'GET /api/products should return 200');
    assert.ok(Array.isArray(res.body), 'response should be an array of products');
    assert.equal(
      res.headers.get('x-served-by'),
      'inventory-service',
      'gateway should report which service answered',
    );
  });

  it('returns 404 with the route list for an unknown prefix', async () => {
    const res = await api.get('/api/does-not-exist');
    assert.equal(res.status, 404, 'unknown prefix should 404');
    assert.ok(
      Array.isArray(res.body.availableRoutes),
      'a 404 should tell the caller which routes do exist',
    );
  });

  it('reports every service as up', async () => {
    const res = await api.get('/health');
    assert.equal(res.body.allUp, true, `not all services are up: ${JSON.stringify(res.body.services)}`);
  });
});

// ---------------------------------------------------------------------------

describe('Catalog', () => {
  it('has been seeded with at least 100 products', async () => {
    const res = await api.get('/api/products');
    assert.ok(
      res.body.length >= 100,
      `seeder should produce at least 100 products, found ${res.body.length}`,
    );
  });

  it('includes the scarce SKUs used by the other tests', async () => {
    const limited = await getProductBySku('LIMITED-01');
    const flash = await getProductBySku('FLASH-100');
    assert.ok(limited.price > 0, 'LIMITED-01 should have a price');
    assert.ok(flash.price > 0, 'FLASH-100 should have a price');
  });

  it('never reports negative stock or reserved', async () => {
    const res = await api.get('/api/products');
    const bad = res.body.filter((p) => p.stock < 0 || p.reserved < 0);
    assert.equal(bad.length, 0, `negative inventory found: ${JSON.stringify(bad.slice(0, 3))}`);
  });
});

// ---------------------------------------------------------------------------

describe('Users', () => {
  it('creates a user', async () => {
    const user = await createUser('create');
    assert.ok(user.id, 'created user should have an id');
    assert.equal(user.ordersCount, 0, 'a new user has no orders');
  });

  it('rejects a duplicate email with 409', async () => {
    const user = await createUser('dup');
    const again = await api.post('/api/users', { email: user.email, name: 'Someone Else' });
    assert.equal(again.status, 409, 'duplicate email should conflict');
  });

  it('rejects an invalid email with 400', async () => {
    const res = await api.post('/api/users', { email: 'not-an-email', name: 'Bad' });
    assert.equal(res.status, 400, 'validation should reject a malformed email');
  });
});

// ---------------------------------------------------------------------------

describe('Order saga - happy path', () => {
  it('accepts the order as PENDING and returns immediately', async () => {
    const user = await createUser('happy');
    const product = await createProduct({ stock: 20, price: 12.5, label: 'happy' });

    const res = await api.post('/api/orders', {
      userId: user.id,
      productId: product.id,
      quantity: 2,
    });

    assert.equal(res.status, 201, 'order should be accepted');
    assert.equal(res.body.status, 'PENDING', 'the response must not wait for inventory');
    assert.equal(
      Number(res.body.totalPrice),
      Number((product.price * 2).toFixed(2)),
      'totalPrice should be unitPrice x quantity',
    );
  });

  it('reaches CONFIRMED once inventory reserves the stock', async () => {
    const user = await createUser('confirm');
    const product = await createProduct({ stock: 20, label: 'confirm' });

    const created = await api.post('/api/orders', {
      userId: user.id,
      productId: product.id,
      quantity: 3,
    });

    const order = await waitForOrderStatus(created.body.id, 'CONFIRMED');
    assert.equal(order.statusReason, null, 'a confirmed order has no failure reason');

    const after = await getProductBySku(product.sku);
    assert.equal(after.stock, product.stock - 3, 'stock should drop by the ordered quantity');
    assert.equal(after.reserved, product.reserved + 3, 'reserved should rise by the same amount');
  });

  it('records the reservation decision', async () => {
    const user = await createUser('reservation');
    const product = await createProduct({ stock: 20, label: 'resv' });

    const created = await api.post('/api/orders', {
      userId: user.id,
      productId: product.id,
      quantity: 1,
    });
    await waitForOrderStatus(created.body.id, 'CONFIRMED');

    const res = await api.get(`/api/reservations/${created.body.id}`);
    assert.equal(res.body.status, 'RESERVED', 'reservation should be RESERVED');
    assert.equal(res.body.quantity, 1, 'reservation should record the quantity');
  });

  it('updates the user read model from order.confirmed', async () => {
    const user = await createUser('readmodel');
    const product = await createProduct({ stock: 20, label: 'readmodel' });

    const created = await api.post('/api/orders', {
      userId: user.id,
      productId: product.id,
      quantity: 2,
    });
    await waitForOrderStatus(created.body.id, 'CONFIRMED');

    const updated = await waitFor('user read model to catch up', async () => {
      const res = await api.get(`/api/users/${user.id}`);
      return res.body.ordersCount === 1 ? res.body : null;
    });

    assert.equal(
      Number(updated.totalSpent),
      Number(created.body.totalPrice),
      'totalSpent should match the confirmed order',
    );
  });

  it('produces notifications by consuming events', async () => {
    const user = await createUser('notify');
    const product = await createProduct({ stock: 20, label: 'notify' });

    const created = await api.post('/api/orders', {
      userId: user.id,
      productId: product.id,
      quantity: 1,
    });
    await waitForOrderStatus(created.body.id, 'CONFIRMED');

    const notes = await waitFor('notifications for the order', async () => {
      const res = await api.get(`/api/notifications?userId=${user.id}`);
      const topics = (res.body || []).map((n) => n.topic);
      return topics.includes('order.confirmed') ? res.body : null;
    });

    const topics = notes.map((n) => n.topic);
    assert.ok(topics.includes('user.created'), 'user.created should produce a notification');
    assert.ok(topics.includes('order.created'), 'order.created should produce a notification');
  });
});

// ---------------------------------------------------------------------------

describe('Order saga - rejection path', () => {
  it('cancels the order when stock is insufficient', async () => {
    const user = await createUser('reject');
    const product = await createProduct({ stock: 2, label: 'scarce' });
    const tooMany = product.stock + 5;

    const created = await api.post('/api/orders', {
      userId: user.id,
      productId: product.id,
      quantity: tooMany,
    });
    assert.equal(created.body.status, 'PENDING', 'rejection happens asynchronously, not at POST time');

    const order = await waitForOrderStatus(created.body.id, 'CANCELLED');
    assert.includes(order.statusReason, 'OUT_OF_STOCK', 'reason should say why');
  });

  it('reports the real available quantity in the reason', async () => {
    // This is the regression test for a bug where the rejection message
    // reported the stock AFTER a successful decrement, producing nonsense
    // like "requested 2, available 103".
    const user = await createUser('reason');
    const product = await createProduct({ stock: 2, label: 'reason' });
    const tooMany = product.stock + 3;

    const created = await api.post('/api/orders', {
      userId: user.id,
      productId: product.id,
      quantity: tooMany,
    });
    const order = await waitForOrderStatus(created.body.id, 'CANCELLED');

    const available = Number(/available (\d+)/.exec(order.statusReason)?.[1]);
    const requested = Number(/requested (\d+)/.exec(order.statusReason)?.[1]);

    assert.equal(requested, tooMany, 'reason should echo the requested quantity');
    assert.ok(
      available < requested,
      `a rejection must have available < requested, got "${order.statusReason}"`,
    );
  });

  it('does not touch stock when the order is rejected', async () => {
    const user = await createUser('nostockchange');
    const before = await createProduct({ stock: 2, label: 'untouched' });

    const created = await api.post('/api/orders', {
      userId: user.id,
      productId: before.id,
      quantity: before.stock + 10,
    });
    await waitForOrderStatus(created.body.id, 'CANCELLED');

    const after = await getProductBySku(before.sku);
    assert.equal(after.stock, before.stock, 'a rejected order must leave stock untouched');
    assert.equal(after.reserved, before.reserved, 'a rejected order must not reserve anything');
  });

  it('rejects an order for a user that does not exist', async () => {
    const product = await createProduct({ stock: 5, label: 'nouser' });
    const res = await api.post('/api/orders', {
      userId: uuid(),
      productId: product.id,
      quantity: 1,
    });
    assert.equal(res.status, 400, 'unknown user should fail fast, synchronously');
  });

  it('rejects an order for a product that does not exist', async () => {
    const user = await createUser('noproduct');
    const res = await api.post('/api/orders', {
      userId: user.id,
      productId: uuid(),
      quantity: 1,
    });
    assert.equal(res.status, 400, 'unknown product should fail fast, synchronously');
  });

  it('rejects invalid quantities', async () => {
    const user = await createUser('badqty');
    const product = await createProduct({ stock: 5, label: 'badqty' });

    for (const quantity of [0, -1, 'abc']) {
      const res = await api.post('/api/orders', {
        userId: user.id,
        productId: product.id,
        quantity,
      });
      assert.equal(res.status, 400, `quantity ${JSON.stringify(quantity)} should be rejected`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('Idempotency', () => {
  it('returns the same order for a repeated Idempotency-Key', async () => {
    const user = await createUser('idem');
    const product = await createProduct({ stock: 20, label: 'idem' });
    const key = uuid();
    const body = { userId: user.id, productId: product.id, quantity: 1 };

    const first = await api.post('/api/orders', body, { headers: { 'Idempotency-Key': key } });
    const second = await api.post('/api/orders', body, { headers: { 'Idempotency-Key': key } });

    assert.equal(first.body.id, second.body.id, 'a retry must not create a second order');
    assert.equal(
      second.headers.get('idempotent-replay'),
      'true',
      'the replayed response should be flagged (gateway must forward the header)',
    );
  });

  it('only decrements stock once for a repeated request', async () => {
    const user = await createUser('idemstock');
    const before = await createProduct({ stock: 30, label: 'idemstock' });
    const key = uuid();
    const body = { userId: user.id, productId: before.id, quantity: 4 };

    const first = await api.post('/api/orders', body, { headers: { 'Idempotency-Key': key } });
    await api.post('/api/orders', body, { headers: { 'Idempotency-Key': key } });
    await api.post('/api/orders', body, { headers: { 'Idempotency-Key': key } });

    await waitForOrderStatus(first.body.id, 'CONFIRMED');

    const after = await getProductBySku(before.sku);
    assert.equal(after.stock, before.stock - 4, 'three identical requests must move stock once');
  });

  it('rejects a reused key carrying a different body', async () => {
    const user = await createUser('idemmismatch');
    const product = await createProduct({ stock: 20, label: 'mismatch' });
    const key = uuid();

    await api.post(
      '/api/orders',
      { userId: user.id, productId: product.id, quantity: 1 },
      { headers: { 'Idempotency-Key': key } },
    );
    const mismatch = await api.post(
      '/api/orders',
      { userId: user.id, productId: product.id, quantity: 9 },
      { headers: { 'Idempotency-Key': key } },
    );

    assert.equal(mismatch.status, 422, 'reusing a key with a different body is a client bug');
  });

  it('creates separate orders for different keys', async () => {
    const user = await createUser('idemdiff');
    const product = await createProduct({ stock: 20, label: 'idemdiff' });
    const body = { userId: user.id, productId: product.id, quantity: 1 };

    const a = await api.post('/api/orders', body, { headers: { 'Idempotency-Key': uuid() } });
    const b = await api.post('/api/orders', body, { headers: { 'Idempotency-Key': uuid() } });

    assert.notEqual(a.body.id, b.body.id, 'different keys are different purchases');
  });

  it('still works without the header', async () => {
    const user = await createUser('nokey');
    const product = await createProduct({ stock: 20, label: 'nokey' });
    const body = { userId: user.id, productId: product.id, quantity: 1 };

    const a = await api.post('/api/orders', body);
    const b = await api.post('/api/orders', body);

    assert.equal(a.status, 201, 'the header is optional');
    assert.notEqual(a.body.id, b.body.id, 'without a key, two POSTs are two orders');
  });
});

run();
