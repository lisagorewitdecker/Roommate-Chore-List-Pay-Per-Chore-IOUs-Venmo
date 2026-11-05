const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { createApp } = require('../server.cjs');

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('Supply integration tests require TEST_DATABASE_URL. Run them with npm test or npm run test:integration.');
} else {
  const secret = 'supply-integration-test-secret';
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
    endpoint = `http://127.0.0.1:${server.address().port}/api/supplies`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  });

  async function createFixture() {
    const household = await pool.query(
      'INSERT INTO households (name, invite_code) VALUES ($1, $2) RETURNING id',
      ['Supply integration test', randomUUID().replaceAll('-', '').slice(0, 12)]
    );
    const householdId = household.rows[0].id;
    const userIds = [];
    for (const name of ['Buyer', 'Roommate one', 'Roommate two']) {
      const user = await pool.query(
        `INSERT INTO users (household_id, name, email, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [householdId, name, `${randomUUID()}@example.test`, 'not-used']
      );
      userIds.push(user.rows[0].id);
    }

    return {
      householdId,
      buyerId: userIds[0],
      roommateIds: userIds.slice(1),
      token: jwt.sign({ id: userIds[0] }, secret),
      async cleanup() {
        await pool.query('DELETE FROM households WHERE id = $1', [householdId]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      }
    };
  }

  async function call(path, { method = 'GET', token, body } = {}) {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { response, body: await response.json() };
  }

  async function createSupply(fixture, overrides = {}) {
    return call('', {
      method: 'POST',
      token: fixture.token,
      body: {
        name: 'Groceries',
        quantity: 'One shopping trip',
        price_cents: 500,
        assigned_to: fixture.buyerId,
        ...overrides
      }
    });
  }

  test('shared purchase creates rounded source-linked IOUs without charging the buyer for their own share', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const created = await createSupply(fixture, { beneficiary_id: null });
    assert.equal(created.response.status, 201);

    const purchase = await call(`/${created.body.supply.id}/purchase`, {
      method: 'POST',
      token: fixture.token,
      body: { actual_price_cents: 101 }
    });
    const debts = await pool.query(
      'SELECT debtor_id, creditor_id, amount_cents, source_supply_id FROM ious WHERE source_supply_id = $1 ORDER BY debtor_id',
      [created.body.supply.id]
    );
    const members = await pool.query(
      'SELECT id FROM users WHERE household_id = $1 ORDER BY id',
      [fixture.householdId]
    );
    const baseShare = Math.floor(101 / members.rows.length);
    const remainder = 101 % members.rows.length;
    const expectedDebts = new Map(members.rows
      .map((member, index) => [member.id, baseShare + (index < remainder ? 1 : 0)])
      .filter(([memberId]) => memberId !== fixture.buyerId));

    assert.equal(purchase.response.status, 200);
    assert.equal(debts.rows.length, 2);
    assert.ok(debts.rows.every(debt => debt.creditor_id === fixture.buyerId));
    assert.deepEqual(new Map(debts.rows.map(debt => [debt.debtor_id, debt.amount_cents])), expectedDebts);
    assert.ok(debts.rows.every(debt => debt.source_supply_id === created.body.supply.id));
    const purchased = await pool.query(
      'SELECT purchased_by, actual_price_cents, purchased_at FROM cleaning_supplies WHERE id = $1',
      [created.body.supply.id]
    );
    assert.equal(purchased.rows[0].purchased_by, fixture.buyerId);
    assert.equal(purchased.rows[0].actual_price_cents, 101);
    assert.ok(purchased.rows[0].purchased_at);

    const retry = await call(`/${created.body.supply.id}/purchase`, {
      method: 'POST',
      token: fixture.token,
      body: { actual_price_cents: 101 }
    });
    assert.equal(retry.response.status, 409);
  });

  test('individual purchase assigns the full actual cost only to the selected household member', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const beneficiaryId = fixture.roommateIds[0];
    const created = await createSupply(fixture, { beneficiary_id: beneficiaryId });
    assert.equal(created.response.status, 201);

    const purchase = await call(`/${created.body.supply.id}/purchase`, {
      method: 'POST',
      token: fixture.token,
      body: { actual_price_cents: 799 }
    });
    const debts = await pool.query(
      'SELECT debtor_id, creditor_id, amount_cents FROM ious WHERE source_supply_id = $1',
      [created.body.supply.id]
    );

    assert.equal(purchase.response.status, 200);
    assert.deepEqual(debts.rows.map(({ debtor_id, creditor_id, amount_cents }) => ({ debtor_id, creditor_id, amount_cents })), [
      { debtor_id: beneficiaryId, creditor_id: fixture.buyerId, amount_cents: 799 }
    ]);
  });

  test('concurrent purchase attempts cannot duplicate IOUs and zero-cost purchases record no debt', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const created = await createSupply(fixture, { beneficiary_id: null });
    const attempt = () => call(`/${created.body.supply.id}/purchase`, {
      method: 'POST',
      token: fixture.token,
      body: { actual_price_cents: 20 }
    });
    const results = await Promise.all([attempt(), attempt()]);
    assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
    const debts = await pool.query('SELECT id FROM ious WHERE source_supply_id = $1', [created.body.supply.id]);
    assert.equal(debts.rows.length, 2);

    const freeSupply = await createSupply(fixture, { name: 'Free samples', beneficiary_id: null });
    const freePurchase = await call(`/${freeSupply.body.supply.id}/purchase`, {
      method: 'POST',
      token: fixture.token,
      body: { actual_price_cents: 0 }
    });
    const freeDebts = await pool.query('SELECT id FROM ious WHERE source_supply_id = $1', [freeSupply.body.supply.id]);
    assert.equal(freePurchase.response.status, 200);
    assert.equal(freeDebts.rows.length, 0);
  });

  test('rolls back purchase details when source IOU creation fails', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const created = await createSupply(fixture, { beneficiary_id: null });
    await pool.query(`
      CREATE OR REPLACE FUNCTION supply_test_reject_source_iou() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_supply_id IS NOT NULL THEN RAISE EXCEPTION 'injected source IOU failure'; END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query('DROP TRIGGER IF EXISTS supply_test_reject_source_iou ON ious');
    await pool.query(`
      CREATE TRIGGER supply_test_reject_source_iou
      BEFORE INSERT ON ious FOR EACH ROW EXECUTE FUNCTION supply_test_reject_source_iou()
    `);

    try {
      const purchase = await call(`/${created.body.supply.id}/purchase`, {
        method: 'POST',
        token: fixture.token,
        body: { actual_price_cents: 500 }
      });
      assert.equal(purchase.response.status, 500);
      const supply = await pool.query(
        'SELECT purchased_at, purchased_by, actual_price_cents FROM cleaning_supplies WHERE id = $1',
        [created.body.supply.id]
      );
      const debts = await pool.query('SELECT id FROM ious WHERE source_supply_id = $1', [created.body.supply.id]);
      assert.equal(supply.rows[0].purchased_at, null);
      assert.equal(supply.rows[0].purchased_by, null);
      assert.equal(supply.rows[0].actual_price_cents, null);
      assert.equal(debts.rows.length, 0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS supply_test_reject_source_iou ON ious');
      await pool.query('DROP FUNCTION IF EXISTS supply_test_reject_source_iou()');
    }
  });
}