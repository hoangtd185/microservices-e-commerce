'use strict';

/**
 * Tiny test harness - no dependencies, no test runner to install.
 * Node 18+ has fetch built in, which is all we need to drive the gateway.
 */

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:3000';

// ---------------------------------------------------------------- output ---

const color = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const green = color(32);
const red = color(31);
const yellow = color(33);
const dim = color(90);
const bold = color(1);

// ------------------------------------------------------------ assertions ---

class AssertionError extends Error {}

function fail(message) {
  throw new AssertionError(message);
}

const assert = {
  equal(actual, expected, what) {
    if (actual !== expected) {
      fail(`${what}\n      expected: ${expected}\n      actual:   ${actual}`);
    }
  },
  notEqual(actual, forbidden, what) {
    if (actual === forbidden) fail(`${what}\n      must not be: ${forbidden}`);
  },
  ok(value, what) {
    if (!value) fail(what);
  },
  atMost(actual, max, what) {
    if (actual > max) {
      fail(`${what}\n      expected: <= ${max}\n      actual:   ${actual}`);
    }
  },
  includes(haystack, needle, what) {
    if (!String(haystack).includes(needle)) {
      fail(`${what}\n      expected to contain: ${needle}\n      actual:              ${haystack}`);
    }
  },
};

// ------------------------------------------------------------ http client --

async function request(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  return { status: res.status, body: parsed, headers: res.headers };
}

const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { body, ...opts }),
  patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
};

// ----------------------------------------------------------------- utils ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The saga is asynchronous, so tests cannot assert immediately after POSTing.
 * Poll until the condition holds or we give up - never a blind sleep, which
 * is both slower and flakier.
 */
async function waitFor(describe, predicate, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  fail(`timed out after ${timeoutMs}ms waiting for: ${describe}`);
}

async function waitForOrderStatus(orderId, expected, opts) {
  return waitFor(
    `order ${orderId.slice(0, 8)} to become ${expected}`,
    async () => {
      const res = await api.get(`/api/orders/${orderId}`);
      return res.body && res.body.status === expected ? res.body : null;
    },
    opts,
  );
}

const uuid = () => globalThis.crypto.randomUUID();

// --------------------------------------------------------- domain helpers --

/** Every test gets its own user so runs never interfere with each other. */
async function createUser(label = 'tester') {
  const res = await api.post('/api/users', {
    email: `${label}+${uuid().slice(0, 8)}@example.com`,
    name: `Test ${label}`,
  });
  if (res.status !== 201) {
    fail(`could not create user (status ${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function getProductBySku(sku) {
  const res = await api.get('/api/products');
  const product = (res.body || []).find((p) => p.sku === sku);
  if (!product) {
    fail(`product ${sku} not found - run the seeder: docker compose exec inventory-service node dist/seed/seed.js`);
  }
  return product;
}

/**
 * A private product for one test.
 *
 * Test isolation matters more here than usual: the saga is asynchronous, so an
 * order from an earlier test can settle in the middle of a later test's stock
 * measurement. Sharing a SKU makes the suite flaky in a way that looks like an
 * application bug. One row per test removes the problem entirely.
 */
async function createProduct({ stock = 100, price = 9.99, label = 'fixture' } = {}) {
  const sku = `TEST-${label}-${uuid().slice(0, 8)}`.toUpperCase();
  const created = await api.post('/api/products', {
    sku,
    name: `Test fixture ${label}`,
    price,
    stock,
  });
  if (created.status !== 201) {
    fail(`could not create product (status ${created.status}): ${JSON.stringify(created.body)}`);
  }
  // Re-read so DB defaults (reserved) are populated.
  const res = await api.get(`/api/products/${created.body.id}`);
  return res.body;
}

/** Restock a product back up to a known level, so tests are repeatable. */
async function ensureStock(sku, target) {
  const product = await getProductBySku(sku);
  const missing = target - product.stock;
  if (missing > 0) {
    await api.patch(`/api/products/${product.id}/restock`, { quantity: missing });
  }
  return getProductBySku(sku);
}

// ------------------------------------------------------------- test runner -

const suites = [];
let currentSuite = null;

function describe(name, fn) {
  currentSuite = { name, tests: [] };
  suites.push(currentSuite);
  fn(); // registration happens now; the tests themselves run later
  currentSuite = null;
}

function it(name, fn) {
  if (!currentSuite) throw new Error('it() must be called inside describe()');
  currentSuite.tests.push({ name, fn });
}

async function run() {
  console.log(bold(`\nE2E against ${GATEWAY}\n`));

  // Fail fast with a useful message instead of 40 confusing connection errors.
  try {
    const health = await api.get('/health');
    const down = (health.body.services || []).filter((s) => s.status !== 'up');
    if (down.length) {
      console.log(red(`  Services not up: ${down.map((s) => s.service).join(', ')}`));
      console.log(dim('  Run: docker compose up -d   then retry.\n'));
      process.exit(1);
    }
  } catch (err) {
    console.log(red(`  Cannot reach the gateway at ${GATEWAY}`));
    console.log(dim(`  ${err.message}`));
    console.log(dim('  Run: docker compose up -d   then retry.\n'));
    process.exit(1);
  }

  let passed = 0;
  const failures = [];

  for (const suite of suites) {
    console.log(bold(suite.name));

    for (const test of suite.tests) {
      const started = Date.now();
      try {
        await test.fn();
        const ms = Date.now() - started;
        console.log(`  ${green('PASS')} ${test.name} ${dim(`(${ms}ms)`)}`);
        passed++;
      } catch (err) {
        const ms = Date.now() - started;
        console.log(`  ${red('FAIL')} ${test.name} ${dim(`(${ms}ms)`)}`);
        console.log(yellow(`      ${err.message.split('\n').join('\n      ')}`));
        failures.push({ suite: suite.name, test: test.name, err });
      }
    }
    console.log('');
  }

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(green(bold(`${passed}/${total} passed\n`)));
    process.exit(0);
  }

  console.log(red(bold(`${passed}/${total} passed, ${failures.length} failed\n`)));
  process.exit(1);
}

module.exports = {
  api,
  assert,
  fail,
  describe,
  it,
  run,
  waitFor,
  waitForOrderStatus,
  createUser,
  createProduct,
  getProductBySku,
  ensureStock,
  sleep,
  uuid,
  GATEWAY,
  colors: { green, red, yellow, dim, bold },
};
