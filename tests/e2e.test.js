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
 * published, stock going negative, a forwarded header quietly dropped) is
 * invisible to unit tests with mocks.
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
  adminToken,
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
    const res = await api.get('/api/does-not-exist', { token: await adminToken() });
    assert.equal(res.status, 404, 'unknown prefix should 404');
    assert.ok(
      Array.isArray(res.body.availableRoutes),
      'a 404 should tell the caller which routes do exist',
    );
  });

  it('reports every service as up', async () => {
    const res = await api.get('/health');
    assert.equal(
      res.body.allUp,
      true,
      `not all services are up: ${JSON.stringify(res.body.services)}`,
    );
  });
});

// ---------------------------------------------------------------------------

describe('Auth', () => {
  it('registers a user and returns a token', async () => {
    const email = `reg+${uuid().slice(0, 8)}@example.com`;
    const res = await api.post('/api/auth/register', {
      email,
      name: 'New User',
      password: 'a-long-enough-password',
    });

    assert.equal(res.status, 201, 'registration should succeed');
    assert.ok(res.body.accessToken, 'a token should be issued');
    assert.equal(res.body.user.email, email, 'the user should be returned');
    assert.ok(
      res.body.user.passwordHash === undefined,
      'the password hash must never appear in a response',
    );
  });

  it('rejects a short password', async () => {
    const res = await api.post('/api/auth/register', {
      email: `short+${uuid().slice(0, 8)}@example.com`,
      name: 'Short',
      password: 'abc',
    });
    assert.equal(res.status, 400, 'a weak password should be refused');
  });

  it('rejects a duplicate email', async () => {
    const user = await createUser('dupe');
    const res = await api.post('/api/auth/register', {
      email: user.email,
      name: 'Impostor',
      password: 'a-long-enough-password',
    });
    assert.equal(res.status, 409, 'duplicate email should conflict');
  });

  it('logs in with the right password', async () => {
    const user = await createUser('login');
    const res = await api.post('/api/auth/login', {
      email: user.email,
      password: user.password,
    });

    assert.equal(res.status, 200, 'login should succeed');
    assert.ok(res.body.accessToken, 'login should return a token');
    assert.equal(res.body.user.id, user.id, 'the same user should come back');
  });

  it('refuses a wrong password', async () => {
    const user = await createUser('wrongpw');
    const res = await api.post('/api/auth/login', {
      email: user.email,
      password: 'definitely-not-the-password',
    });
    assert.equal(res.status, 401, 'wrong password should be unauthorized');
  });

  it('gives the same error for an unknown email as for a wrong password', async () => {
    // Different messages here would let an attacker enumerate accounts.
    const user = await createUser('enum');
    const wrongPw = await api.post('/api/auth/login', {
      email: user.email,
      password: 'nope-nope-nope',
    });
    const noSuchUser = await api.post('/api/auth/login', {
      email: `ghost+${uuid().slice(0, 8)}@example.com`,
      password: 'nope-nope-nope',
    });

    assert.equal(wrongPw.status, noSuchUser.status, 'status codes should match');
    assert.equal(
      wrongPw.body.message,
      noSuchUser.body.message,
      'messages should be identical - do not leak which emails exist',
    );
  });
});

// ---------------------------------------------------------------------------

describe('Authorisation', () => {
  it('rejects a protected route with no token', async () => {
    const res = await api.post('/api/orders', { productId: uuid(), quantity: 1 });
    assert.equal(res.status, 401, 'no token should be unauthorized');
  });

  it('rejects a garbage token', async () => {
    const res = await api.get('/api/orders', { token: 'not.a.jwt' });
    assert.equal(res.status, 401, 'a malformed token should be unauthorized');
  });

  it('rejects a token signed with the wrong secret', async () => {
    // header.payload.signature, correctly shaped but signed by nobody we trust
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      Buffer.from(JSON.stringify({ sub: uuid(), email: 'x@y.z' })).toString('base64url') +
      '.YmFkc2lnbmF0dXJl';
    const res = await api.get('/api/orders', { token: forged });
    assert.equal(res.status, 401, 'a forged signature must not be accepted');
  });

  it('leaves the public catalogue open', async () => {
    const res = await api.get('/api/products');
    assert.equal(res.status, 200, 'browsing products should not need an account');
  });

  it('ignores a spoofed x-user-id header', async () => {
    // The attack: send someone else's id and hope a service trusts it.
    const attacker = await createUser('attacker');
    const victim = await createUser('victim');
    const product = await createProduct({ stock: 10, label: 'spoof' });

    const res = await api.post(
      '/api/orders',
      { productId: product.id, quantity: 1 },
      { token: attacker.token, headers: { 'x-user-id': victim.id } },
    );

    assert.equal(res.status, 201, 'the order itself should succeed');
    assert.equal(
      res.body.userId,
      attacker.id,
      'the order must belong to the TOKEN holder, not the spoofed header',
    );
    assert.notEqual(res.body.userId, victim.id, 'the spoof must not work');
  });

  it('does not let one user read another user\'s order', async () => {
    const owner = await createUser('owner');
    const nosy = await createUser('nosy');
    const product = await createProduct({ stock: 10, label: 'private' });

    const created = await api.post(
      '/api/orders',
      { productId: product.id, quantity: 1 },
      { token: owner.token },
    );

    const asOwner = await api.get(`/api/orders/${created.body.id}`, { token: owner.token });
    const asNosy = await api.get(`/api/orders/${created.body.id}`, { token: nosy.token });

    assert.equal(asOwner.status, 200, 'the owner can read their own order');
    assert.equal(asNosy.status, 404, 'someone else gets 404, not the order');
  });

  it('scopes the order list to the caller', async () => {
    const a = await createUser('listA');
    const b = await createUser('listB');
    const product = await createProduct({ stock: 10, label: 'listscope' });

    await api.post('/api/orders', { productId: product.id, quantity: 1 }, { token: a.token });

    const bList = await api.get('/api/orders', { token: b.token });
    assert.equal(bList.status, 200, 'listing should work');
    assert.equal(
      bList.body.filter((o) => o.userId === a.id).length,
      0,
      "user B must not see user A's orders",
    );
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

  it('includes the scarce SKUs used for manual experiments', async () => {
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

describe('Order saga - happy path', () => {
  it('accepts the order as PENDING and returns immediately', async () => {
    const user = await createUser('happy');
    const product = await createProduct({ stock: 20, price: 12.5, label: 'happy' });

    const res = await api.post(
      '/api/orders',
      { productId: product.id, quantity: 2 },
      { token: user.token },
    );

    assert.equal(res.status, 201, 'order should be accepted');
    assert.equal(res.body.status, 'PENDING', 'the response must not wait for inventory');
    assert.equal(res.body.userId, user.id, 'the order belongs to the token holder');
    assert.equal(
      Number(res.body.totalPrice),
      Number((product.price * 2).toFixed(2)),
      'totalPrice should be unitPrice x quantity',
    );
  });

  it('reaches CONFIRMED once inventory reserves the stock', async () => {
    const user = await createUser('confirm');
    const product = await createProduct({ stock: 20, label: 'confirm' });

    const created = await api.post(
      '/api/orders',
      { productId: product.id, quantity: 3 },
      { token: user.token },
    );

    const order = await waitForOrderStatus(created.body.id, 'CONFIRMED', user.token);
    assert.equal(order.statusReason, null, 'a confirmed order has no failure reason');

    const after = await getProductBySku(product.sku);
    assert.equal(after.stock, product.stock - 3, 'stock should drop by the ordered quantity');
    assert.equal(after.reserved, product.reserved + 3, 'reserved should rise by the same amount');
  });

  it('records the reservation decision', async () => {
    const user = await createUser('reservation');
    const product = await createProduct({ stock: 20, label: 'resv' });

    const created = await api.post(
      '/api/orders',
      { productId: product.id, quantity: 1 },
      { token: user.token },
    );
    await waitForOrderStatus(created.body.id, 'CONFIRMED', user.token);

    const res = await api.get(`/api/reservations/${created.body.id}`, { token: user.token });
    assert.equal(res.body.status, 'RESERVED', 'reservation should be RESERVED');
    assert.equal(res.body.quantity, 1, 'reservation should record the quantity');
  });

  it('updates the user read model from order.confirmed', async () => {
    const user = await createUser('readmodel');
    const product = await createProduct({ stock: 20, label: 'readmodel' });

    const created = await api.post(
      '/api/orders',
      { productId: product.id, quantity: 2 },
      { token: user.token },
    );
    await waitForOrderStatus(created.body.id, 'CONFIRMED', user.token);

    const updated = await waitFor('user read model to catch up', async () => {
      const res = await api.get(`/api/users/${user.id}`, { token: user.token });
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

    const created = await api.post(
      '/api/orders',
      { productId: product.id, quantity: 1 },
      { token: user.token },
    );
    await waitForOrderStatus(created.body.id, 'CONFIRMED', user.token);

    const notes = await waitFor('notifications for the order', async () => {
      const res = await api.get(`/api/notifications?userId=${user.id}`, { token: user.token });
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

    const created = await api.post(
      '/api/orders',
      { productId: product.id, quantity: product.stock + 5 },
      { token: user.token },
    );
    assert.equal(
      created.body.status,
      'PENDING',
      'rejection happens asynchronously, not at POST time',
    );

    const order = await waitForOrderStatus(created.body.id, 'CANCELLED', user.token);
    assert.includes(order.statusReason, 'OUT_OF_STOCK', 'reason should say why');
  });

  it('reports the real available quantity in the reason', async () => {
    // Regression test: a bug once reported the stock AFTER a successful
    // decrement, producing nonsense like "requested 2, available 103".
    const user = await createUser('reason');
    const product = await createProduct({ stock: 2, label: 'reason' });
    const tooMany = product.stock + 3;

    const created = await api.post(
      '/api/orders',
      { productId: product.id, quantity: tooMany },
      { token: user.token },
    );
    const order = await waitForOrderStatus(created.body.id, 'CANCELLED', user.token);

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

    const created = await api.post(
      '/api/orders',
      { productId: before.id, quantity: before.stock + 10 },
      { token: user.token },
    );
    await waitForOrderStatus(created.body.id, 'CANCELLED', user.token);

    const after = await getProductBySku(before.sku);
    assert.equal(after.stock, before.stock, 'a rejected order must leave stock untouched');
    assert.equal(after.reserved, before.reserved, 'a rejected order must not reserve anything');
  });

  it('rejects an order for a product that does not exist', async () => {
    const user = await createUser('noproduct');
    const res = await api.post(
      '/api/orders',
      { productId: uuid(), quantity: 1 },
      { token: user.token },
    );
    assert.equal(res.status, 400, 'unknown product should fail fast, synchronously');
  });

  it('rejects invalid quantities', async () => {
    const user = await createUser('badqty');
    const product = await createProduct({ stock: 5, label: 'badqty' });

    for (const quantity of [0, -1, 'abc']) {
      const res = await api.post(
        '/api/orders',
        { productId: product.id, quantity },
        { token: user.token },
      );
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
    const body = { productId: product.id, quantity: 1 };
    const opts = { token: user.token, headers: { 'Idempotency-Key': key } };

    const first = await api.post('/api/orders', body, opts);
    const second = await api.post('/api/orders', body, opts);

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
    const body = { productId: before.id, quantity: 4 };
    const opts = { token: user.token, headers: { 'Idempotency-Key': key } };

    const first = await api.post('/api/orders', body, opts);
    await api.post('/api/orders', body, opts);
    await api.post('/api/orders', body, opts);

    await waitForOrderStatus(first.body.id, 'CONFIRMED', user.token);

    const after = await getProductBySku(before.sku);
    assert.equal(after.stock, before.stock - 4, 'three identical requests must move stock once');
  });

  it('rejects a reused key carrying a different body', async () => {
    const user = await createUser('idemmismatch');
    const product = await createProduct({ stock: 20, label: 'mismatch' });
    const key = uuid();
    const opts = { token: user.token, headers: { 'Idempotency-Key': key } };

    await api.post('/api/orders', { productId: product.id, quantity: 1 }, opts);
    const mismatch = await api.post(
      '/api/orders',
      { productId: product.id, quantity: 9 },
      opts,
    );

    assert.equal(mismatch.status, 422, 'reusing a key with a different body is a client bug');
  });

  it('creates separate orders for different keys', async () => {
    const user = await createUser('idemdiff');
    const product = await createProduct({ stock: 20, label: 'idemdiff' });
    const body = { productId: product.id, quantity: 1 };

    const a = await api.post('/api/orders', body, {
      token: user.token,
      headers: { 'Idempotency-Key': uuid() },
    });
    const b = await api.post('/api/orders', body, {
      token: user.token,
      headers: { 'Idempotency-Key': uuid() },
    });

    assert.notEqual(a.body.id, b.body.id, 'different keys are different purchases');
  });

  it('still works without the header', async () => {
    const user = await createUser('nokey');
    const product = await createProduct({ stock: 20, label: 'nokey' });
    const body = { productId: product.id, quantity: 1 };

    const a = await api.post('/api/orders', body, { token: user.token });
    const b = await api.post('/api/orders', body, { token: user.token });

    assert.equal(a.status, 201, 'the header is optional');
    assert.notEqual(a.body.id, b.body.id, 'without a key, two POSTs are two orders');
  });
});

// ---------------------------------------------------------------------------

describe('Transactional outbox', () => {
  it('delivers the event even though nothing publishes inline', async () => {
    // The whole point of the outbox: the POST handler never talks to Kafka.
    // If the saga still completes, the relay did its job.
    const user = await createUser('outbox');
    const product = await createProduct({ stock: 5, label: 'outbox' });

    const created = await api.post(
      '/api/orders',
      { productId: product.id, quantity: 1 },
      { token: user.token },
    );

    const order = await waitForOrderStatus(created.body.id, 'CONFIRMED', user.token);
    assert.equal(order.status, 'CONFIRMED', 'the relay must have published order.created');
  });

  it('drains the queue - no order is left stuck in PENDING', async () => {
    const user = await createUser('drain');
    const product = await createProduct({ stock: 30, label: 'drain' });

    const responses = await Promise.all(
      Array.from({ length: 15 }, () =>
        api.post('/api/orders', { productId: product.id, quantity: 1 }, { token: user.token }),
      ),
    );

    const settled = await waitFor(
      'all 15 orders to settle',
      async () => {
        const orders = await Promise.all(
          responses.map(async (r) =>
            (await api.get(`/api/orders/${r.body.id}`, { token: user.token })).body,
          ),
        );
        return orders.every((o) => o.status !== 'PENDING') ? orders : null;
      },
      { timeoutMs: 30000 },
    );

    assert.equal(
      settled.filter((o) => o.status === 'CONFIRMED').length,
      15,
      'every order should have been confirmed - none lost, none stuck',
    );
  });
});

run();
