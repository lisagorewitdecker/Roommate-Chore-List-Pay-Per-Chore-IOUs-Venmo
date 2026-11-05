const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { createApp } = require('../server.cjs');

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('Payment integration tests require TEST_DATABASE_URL. Run them with npm test or npm run test:integration.');
} else {
  const secret = 'payment-test-secret';
  const previousJwtSecret = process.env.JWT_SECRET;
  const pool = new Pool({ connectionString: databaseUrl });
  let server;
  let endpoint;

  before(async () => {
    process.env.JWT_SECRET = secret;
    server = createApp({ pool }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    endpoint = `http://127.0.0.1:${server.address().port}/api/payments/pay-chore`;
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    await pool.end();
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
  });

  async function createFixture({
    payerBalance = 1000,
    payeeBalance = 100,
    amount = 350,
    status = 'completed',
    selfPay = false,
    unassigned = false,
    crossHousehold = false
  } = {}) {
    const households = [];
    const users = [];
    const householdResult = await pool.query(
      'INSERT INTO households (name, invite_code) VALUES ($1, $2) RETURNING id',
      ['Payment integration test', randomUUID().replaceAll('-', '').slice(0, 12)]
    );
    const householdId = householdResult.rows[0].id;
    households.push(householdId);

    const payerResult = await pool.query(
      `INSERT INTO users (household_id, name, email, password_hash, balance_cents)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [householdId, 'Payer', `${randomUUID()}@example.test`, 'not-used', payerBalance]
    );
    const payerId = payerResult.rows[0].id;
    users.push(payerId);

    let payeeHouseholdId = householdId;
    if (crossHousehold) {
      const otherHouseholdResult = await pool.query(
        'INSERT INTO households (name, invite_code) VALUES ($1, $2) RETURNING id',
        ['Other test household', randomUUID().replaceAll('-', '').slice(0, 12)]
      );
      payeeHouseholdId = otherHouseholdResult.rows[0].id;
      households.push(payeeHouseholdId);
    }

    const payeeResult = await pool.query(
      `INSERT INTO users (household_id, name, email, password_hash, balance_cents)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [payeeHouseholdId, 'Payee', `${randomUUID()}@example.test`, 'not-used', payeeBalance]
    );
    const payeeId = payeeResult.rows[0].id;
    users.push(payeeId);

    async function addChore({ choreAmount = amount, assignedTo = unassigned ? null : (selfPay ? payerId : payeeId), choreStatus = status } = {}) {
      const choreResult = await pool.query(
        `INSERT INTO chores (household_id, title, price_cents, created_by, assigned_to, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [householdId, 'Integration test chore', choreAmount, payerId, assignedTo, choreStatus]
      );
      return choreResult.rows[0].id;
    }

    const choreId = await addChore();

    return {
      householdId,
      payerId,
      payeeId,
      choreId,
      addChore,
      async cleanup() {
        await pool.query(
          'DELETE FROM transactions WHERE payer_id = ANY($1::uuid[]) OR payee_id = ANY($1::uuid[])',
          [users]
        );
        await pool.query('DELETE FROM households WHERE id = ANY($1::uuid[])', [households]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
      }
    };
  }

  function authHeaders(userId) {
    return { Authorization: `Bearer ${jwt.sign({ id: userId }, secret)}` };
  }

  async function pay(choreId, userId, body = { chore_id: choreId }) {
    const headers = { 'Content-Type': 'application/json' };
    if (userId) Object.assign(headers, authHeaders(userId));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    return { response, body: await response.json() };
  }

  async function balances(fixture) {
    const result = await pool.query(
      'SELECT id, balance_cents FROM users WHERE id = ANY($1::uuid[])',
      [[fixture.payerId, fixture.payeeId]]
    );
    return Object.fromEntries(result.rows.map(row => [row.id, row.balance_cents]));
  }

  test('settles a completed chore and records the transaction atomically', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);

    const { response, body } = await pay(fixture.choreId, fixture.payerId, {
      chore_id: fixture.choreId,
      payer_id: fixture.payeeId,
      payee_id: fixture.payerId
    });

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.transaction.chore_id, fixture.choreId);
    assert.equal(body.transaction.payer_id, fixture.payerId);
    assert.equal(body.transaction.payee_id, fixture.payeeId);
    assert.equal(body.transaction.amount_cents, 350);
    assert.deepEqual(await balances(fixture), {
      [fixture.payerId]: 650,
      [fixture.payeeId]: 450
    });
    const chore = await pool.query('SELECT status FROM chores WHERE id = $1', [fixture.choreId]);
    assert.equal(chore.rows[0].status, 'verified_paid');
  });

  test('does not allow a second full wallet charge for a household-IOU chore', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    await pool.query("UPDATE chores SET settlement_type = 'household_iou' WHERE id = $1", [fixture.choreId]);

    const { response, body } = await pay(fixture.choreId, fixture.payerId);
    assert.equal(response.status, 409);
    assert.match(body.error, /household IOUs/);
    assert.deepEqual(await balances(fixture), {
      [fixture.payerId]: 1000,
      [fixture.payeeId]: 100
    });
    const transactions = await pool.query('SELECT id FROM transactions WHERE chore_id = $1', [fixture.choreId]);
    assert.equal(transactions.rows.length, 0);
  });

  test('requires a valid authenticated user', async () => {
    const { response, body } = await pay(randomUUID(), null);
    assert.equal(response.status, 401);
    assert.equal(body.error, 'Missing or malformed token');
  });

  test('rejects missing chores, invalid states, unassigned, self, cross-household, zero-price and underfunded payments', async t => {
    const cases = [
      { name: 'missing chore', fixture: {}, id: randomUUID(), expected: 404 },
      { name: 'incomplete chore', fixture: { status: 'open' }, expected: 400 },
      { name: 'unassigned chore', fixture: { unassigned: true }, expected: 400 },
      { name: 'self payment', fixture: { selfPay: true }, expected: 400 },
      { name: 'cross-household payment', fixture: { crossHousehold: true }, expected: 400 },
      { name: 'zero price', fixture: { amount: 0 }, expected: 400 },
      { name: 'insufficient funds', fixture: { payerBalance: 100 }, expected: 400 }
    ];

    for (const invalidCase of cases) {
      const fixture = await createFixture(invalidCase.fixture);
      t.after(fixture.cleanup);
      const { response, body } = await pay(invalidCase.id || fixture.choreId, fixture.payerId);
      assert.equal(response.status, invalidCase.expected, invalidCase.name);
      assert.equal(typeof body.error, 'string', invalidCase.name);
    }
  });

  test('rolls back balances and chore status when the ledger insert fails', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    await pool.query(`
      CREATE OR REPLACE FUNCTION payment_test_reject_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sensitive payment failure'; END; $$
    `);
    await pool.query('DROP TRIGGER IF EXISTS payment_test_reject_insert ON transactions');
    await pool.query(`
      CREATE TRIGGER payment_test_reject_insert
      BEFORE INSERT ON transactions
      FOR EACH ROW EXECUTE FUNCTION payment_test_reject_insert()
    `);

    try {
      const { response, body } = await pay(fixture.choreId, fixture.payerId);
      assert.equal(response.status, 500);
      assert.deepEqual(body, { error: 'Unable to process payment' });
      assert.deepEqual(await balances(fixture), {
        [fixture.payerId]: 1000,
        [fixture.payeeId]: 100
      });
      const chore = await pool.query('SELECT status FROM chores WHERE id = $1', [fixture.choreId]);
      assert.equal(chore.rows[0].status, 'completed');
      const transactionCount = await pool.query('SELECT count(*)::int AS count FROM transactions WHERE chore_id = $1', [fixture.choreId]);
      assert.equal(transactionCount.rows[0].count, 0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS payment_test_reject_insert ON transactions');
      await pool.query('DROP FUNCTION IF EXISTS payment_test_reject_insert()');
    }
  });

  test('allows only one simultaneous payment for the same chore', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);

    const results = await Promise.all([
      pay(fixture.choreId, fixture.payerId),
      pay(fixture.choreId, fixture.payerId)
    ]);

    assert.deepEqual(results.map(result => result.response.status).sort(), [200, 400]);
    assert.deepEqual(await balances(fixture), {
      [fixture.payerId]: 650,
      [fixture.payeeId]: 450
    });
    const transactionCount = await pool.query('SELECT count(*)::int AS count FROM transactions WHERE chore_id = $1', [fixture.choreId]);
    assert.equal(transactionCount.rows[0].count, 1);
  });

  test('serializes competing spends from the same wallet', async t => {
    const fixture = await createFixture({ payerBalance: 500, amount: 400 });
    t.after(fixture.cleanup);
    const secondChoreId = await fixture.addChore({ choreAmount: 400 });

    const results = await Promise.all([
      pay(fixture.choreId, fixture.payerId),
      pay(secondChoreId, fixture.payerId)
    ]);

    assert.deepEqual(results.map(result => result.response.status).sort(), [200, 400]);
    const currentBalances = await balances(fixture);
    assert.equal(currentBalances[fixture.payerId], 100);
    assert.equal(currentBalances[fixture.payeeId], 500);
    const paidChores = await pool.query(
      "SELECT count(*)::int AS count FROM chores WHERE id = ANY($1::uuid[]) AND status = 'verified_paid'",
      [[fixture.choreId, secondChoreId]]
    );
    assert.equal(paidChores.rows[0].count, 1);
  });

  test('locks both wallets in a stable order for opposing transfers', async t => {
    const fixture = await createFixture({ payerBalance: 1000, payeeBalance: 1000, amount: 600 });
    t.after(fixture.cleanup);
    const reverseChoreId = await fixture.addChore({ choreAmount: 600, assignedTo: fixture.payerId });

    const results = await Promise.all([
      pay(fixture.choreId, fixture.payerId),
      pay(reverseChoreId, fixture.payeeId)
    ]);

    assert.deepEqual(results.map(result => result.response.status), [200, 200]);
    assert.deepEqual(await balances(fixture), {
      [fixture.payerId]: 1000,
      [fixture.payeeId]: 1000
    });
  });
}