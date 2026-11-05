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
    const householdResult = await pool.query(
      'INSERT INTO households (name, invite_code) VALUES ($1, $2) RETURNING id',
      ['Supply integration test', randomUUID().replaceAll('-', '').slice(0, 12)]
    );
    const householdId = householdResult.rows[0].id;
    const userResult = await pool.query(
      `INSERT INTO users (household_id, name, email, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [householdId, 'Test buyer', `${randomUUID()}@example.test`, 'not-used']
    );
    const userId = userResult.rows[0].id;
    const userIds = [userId];

    return {
      householdId,
      userId,
      tokenFor(memberId = userId, householdClaim = householdId) {
        return jwt.sign({ id: memberId, household_id: householdClaim }, secret);
      },
      async addMember(name = 'Another buyer') {
        const result = await pool.query(
          `INSERT INTO users (household_id, name, email, password_hash)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [householdId, name, `${randomUUID()}@example.test`, 'not-used']
        );
        userIds.push(result.rows[0].id);
        return result.rows[0].id;
      },
      async cleanup() {
        await pool.query('DELETE FROM households WHERE id = $1', [householdId]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      }
    };
  }

  async function request(path = '', { method = 'GET', token, body } = {}) {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { response, body: response.status === 204 ? null : await response.json() };
  }

  test('creates a household supply with an assigned buyer and optional cost', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const buyerId = await fixture.addMember('Assigned buyer');

    const { response, body } = await request('', {
      method: 'POST',
      token: fixture.tokenFor(),
      body: { name: 'Dish soap', quantity: '2 bottles', price_cents: 749, assigned_to: buyerId }
    });
    assert.equal(response.status, 201);
    assert.equal(body.supply.name, 'Dish soap');
    assert.equal(body.supply.quantity, '2 bottles');
    assert.equal(body.supply.price_cents, 749);
    assert.deepEqual(body.supply.assigned_member, { id: buyerId, name: 'Assigned buyer' });

    const list = await request('', { token: fixture.tokenFor() });
    assert.equal(list.response.status, 200);
    assert.deepEqual(list.body.members.map(member => member.id).sort(), [fixture.userId, buyerId].sort());
    assert.equal(list.body.supplies.length, 1);
  });

  test('validates names, cents, quantities, and same-household buyer assignments', async t => {
    const fixture = await createFixture();
    const otherHousehold = await createFixture();
    t.after(fixture.cleanup);
    t.after(otherHousehold.cleanup);
    const invalidBodies = [
      { name: '  ' },
      { name: 'x'.repeat(151) },
      { name: 'Bleach', quantity: {} },
      { name: 'Bleach', price_cents: -1 },
      { name: 'Bleach', price_cents: 1.5 },
      { name: 'Bleach', price_cents: '500' },
      { name: 'Bleach', assigned_to: 'not-a-uuid' },
      { name: 'Bleach', assigned_to: otherHousehold.userId }
    ];

    for (const body of invalidBodies) {
      const { response, body: responseBody } = await request('', {
        method: 'POST',
        token: fixture.tokenFor(),
        body
      });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(typeof responseBody.error, 'string');
    }
  });

  test('updates buyer and cost, restricts purchase to the assigned member, then removes the item from the active list', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const firstBuyerId = await fixture.addMember('First buyer');
    const finalBuyerId = await fixture.addMember('Final buyer');
    const created = await request('', {
      method: 'POST',
      token: fixture.tokenFor(),
      body: { name: 'Trash bags', quantity: 'one box' }
    });
    assert.equal(created.response.status, 201);
    const supplyId = created.body.supply.id;

    const update = await request(`/${supplyId}`, {
      method: 'PATCH',
      token: fixture.tokenFor(),
      body: { assigned_to: firstBuyerId, price_cents: 1299 }
    });
    assert.equal(update.response.status, 200);
    assert.equal(update.body.supply.price_cents, 1299);
    assert.equal(update.body.supply.assigned_member.id, firstBuyerId);

    const reassign = await request(`/${supplyId}`, {
      method: 'PATCH',
      token: fixture.tokenFor(),
      body: { assigned_to: finalBuyerId }
    });
    assert.equal(reassign.response.status, 200);
    assert.equal(reassign.body.supply.assigned_member.id, finalBuyerId);

    const wrongBuyer = await request(`/${supplyId}/purchase`, {
      method: 'POST',
      token: fixture.tokenFor(firstBuyerId),
      body: { actual_price_cents: 1299 }
    });
    assert.equal(wrongBuyer.response.status, 403);

    const purchased = await request(`/${supplyId}/purchase`, {
      method: 'POST',
      token: fixture.tokenFor(finalBuyerId),
      body: { actual_price_cents: 1199 }
    });
    assert.equal(purchased.response.status, 200);
    assert.equal(purchased.body.success, true);
    assert.equal(purchased.body.supply.actual_price_cents, 1199);
    assert.equal(purchased.body.supply.purchased_by, finalBuyerId);

    const list = await request('', { token: fixture.tokenFor() });
    assert.equal(list.body.supplies.length, 0);
    const repeatPurchase = await request(`/${supplyId}/purchase`, {
      method: 'POST',
      token: fixture.tokenFor(finalBuyerId),
      body: { actual_price_cents: 1199 }
    });
    assert.equal(repeatPurchase.response.status, 409);

    const readded = await request('', {
      method: 'POST',
      token: fixture.tokenFor(),
      body: { name: 'Trash bags', quantity: 'one box' }
    });
    assert.equal(readded.response.status, 201);
    assert.equal((await request('', { token: fixture.tokenFor() })).body.supplies.length, 1);
  });

  test('isolates supply lists and mutations by the current database household', async t => {
    const fixture = await createFixture();
    const otherHousehold = await createFixture();
    t.after(fixture.cleanup);
    t.after(otherHousehold.cleanup);
    const firstSupply = await request('', {
      method: 'POST',
      token: fixture.tokenFor(),
      body: { name: 'Mop heads' }
    });
    const otherSupply = await request('', {
      method: 'POST',
      token: otherHousehold.tokenFor(),
      body: { name: 'Sponges' }
    });
    assert.equal(firstSupply.response.status, 201);
    assert.equal(otherSupply.response.status, 201);

    const list = await request('', {
      token: fixture.tokenFor(fixture.userId, otherHousehold.householdId)
    });
    assert.deepEqual(list.body.supplies.map(supply => supply.name), ['Mop heads']);
    const crossHouseholdUpdate = await request(`/${otherSupply.body.supply.id}`, {
      method: 'PATCH',
      token: fixture.tokenFor(),
      body: { price_cents: 300 }
    });
    assert.equal(crossHouseholdUpdate.response.status, 404);
  });
}