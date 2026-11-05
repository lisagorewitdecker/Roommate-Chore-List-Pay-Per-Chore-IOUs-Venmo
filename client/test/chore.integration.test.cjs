const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { createApp } = require('../server.cjs');

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('Chore integration tests require TEST_DATABASE_URL. Run them with npm test or npm run test:integration.');
} else {
  const secret = 'chore-integration-test-secret';
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
    endpoint = `http://127.0.0.1:${server.address().port}/api/chores`;
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
      ['Chore integration test', randomUUID().replaceAll('-', '').slice(0, 12)]
    );
    const householdId = householdResult.rows[0].id;
    const userResult = await pool.query(
      `INSERT INTO users (household_id, name, email, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [householdId, 'Test roommate', `${randomUUID()}@example.test`, 'not-used']
    );
    const userId = userResult.rows[0].id;
    const userIds = [userId];

    return {
      householdId,
      userId,
      token: (householdClaim = householdId) => jwt.sign({ id: userId, household_id: householdClaim }, secret),
      tokenFor(memberId, householdClaim = householdId) {
        return jwt.sign({ id: memberId, household_id: householdClaim }, secret);
      },
      async addMember(name = 'Another roommate') {
        const result = await pool.query(
          `INSERT INTO users (household_id, name, email, password_hash)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [householdId, name, `${randomUUID()}@example.test`, 'not-used']
        );
        const memberId = result.rows[0].id;
        userIds.push(memberId);
        return memberId;
      },
      async cleanup() {
        await pool.query(
          'DELETE FROM transactions WHERE payer_id = ANY($1::uuid[]) OR payee_id = ANY($1::uuid[])',
          [userIds]
        );
        await pool.query('DELETE FROM households WHERE id = $1', [householdId]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      }
    };
  }

  async function request(path, { method = 'GET', token, body } = {}) {
    return fetch(`${endpoint}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  }

  async function createChore(fixture, body, token = fixture.token()) {
    const response = await request('', { method: 'POST', token, body });
    return { response, body: response.status === 204 ? null : await response.json() };
  }

  test('creates and lists a priced chore using integer cents and the database schema', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const assigneeId = await fixture.addMember();

    const { response, body } = await createChore(fixture, {
      title: '  Clean the kitchen  ',
      description: 'Wipe counters and mop the floor',
      price_cents: 1250,
      due_date: '2026-11-10',
      assigned_to: assigneeId
    });

    assert.equal(response.status, 201);
    assert.equal(body.chore.title, 'Clean the kitchen');
    assert.equal(body.chore.description, 'Wipe counters and mop the floor');
    assert.equal(body.chore.price_cents, 1250);
    assert.equal(body.chore.status, 'open');
    assert.deepEqual(body.chore.assigned_to, { id: assigneeId, name: 'Another roommate' });
    assert.equal(body.chore.household_id, fixture.householdId);
    assert.equal(body.chore.created_by, fixture.userId);

    const listResponse = await request('', { token: fixture.token() });
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.chores.length, 1);
    assert.equal(listBody.chores[0].price_cents, 1250);
  });

  test('lists only the authenticated user household even when JWT household claims are stale', async t => {
    const first = await createFixture();
    const second = await createFixture();
    t.after(first.cleanup);
    t.after(second.cleanup);
    const chore = { title: 'Wash dishes', price_cents: 250 };

    const firstCreate = await createChore(first, chore);
    const secondCreate = await createChore(second, { ...chore, title: 'Vacuum' });
    assert.equal(firstCreate.response.status, 201);
    assert.equal(secondCreate.response.status, 201);

    const response = await request('', { token: first.token(second.householdId) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.chores.map(item => item.title), ['Wash dishes']);
  });

  test('rejects invalid title, price, description, date, and cross-household assignee inputs', async t => {
    const fixture = await createFixture();
    const otherHousehold = await createFixture();
    t.after(fixture.cleanup);
    t.after(otherHousehold.cleanup);
    const invalidBodies = [
      { title: '  ', price_cents: 100 },
      { title: 'x'.repeat(151), price_cents: 100 },
      { title: 'Valid title' },
      { title: 'Valid title', price_cents: '1250' },
      { title: 'Valid title', price_cents: -1 },
      { title: 'Valid title', price_cents: 1.5 },
      { title: 'Valid title', price_cents: 2147483648 },
      { title: 'Valid title', price_cents: 100, description: {} },
      { title: 'Valid title', price_cents: 100, due_date: '2026-02-31' },
      { title: 'Valid title', price_cents: 100, assigned_to: 'not-a-uuid' },
      { title: 'Valid title', price_cents: 100, assigned_to: otherHousehold.userId }
    ];

    for (const body of invalidBodies) {
      const { response, body: responseBody } = await createChore(fixture, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(typeof responseBody.error, 'string');
    }
  });

  test('completes only open household chores and limits deletion to their creator', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const coworkerId = await fixture.addMember('Coworker');
    const choreResult = await createChore(fixture, {
      title: 'Take out trash',
      price_cents: 350,
      assigned_to: fixture.userId
    });
    const choreId = choreResult.body.chore.id;

    const coworkerDelete = await request(`/${choreId}`, { method: 'DELETE', token: jwt.sign({ id: coworkerId }, secret) });
    assert.equal(coworkerDelete.status, 404);

    const completeResponse = await request(`/${choreId}/complete`, { method: 'PATCH', token: fixture.token() });
    assert.equal(completeResponse.status, 200);
    assert.equal((await completeResponse.json()).chore.status, 'completed');

    const repeatComplete = await request(`/${choreId}`, {
      method: 'PATCH',
      token: fixture.token(),
      body: { status: 'completed' }
    });
    assert.equal(repeatComplete.status, 409);

    const completedDelete = await request(`/${choreId}`, { method: 'DELETE', token: fixture.token() });
    assert.equal(completedDelete.status, 404);

    const openChore = await createChore(fixture, { title: 'Sweep floor', price_cents: 100 });
    const deleteResponse = await request(`/${openChore.body.chore.id}`, { method: 'DELETE', token: fixture.token() });
    assert.equal(deleteResponse.status, 204);
  });

  test('completion creates one rounded household IOU per roommate other than the worker', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    await fixture.addMember('Roommate one');
    await fixture.addMember('Roommate two');
    const created = await createChore(fixture, {
      title: 'Clean shared kitchen',
      price_cents: 101,
      assigned_to: fixture.userId
    });

    const response = await request(`/${created.body.chore.id}/complete`, {
      method: 'PATCH',
      token: fixture.token()
    });
    const body = await response.json();
    const debts = await pool.query(
      'SELECT debtor_id, creditor_id, amount_cents, source_chore_id FROM ious WHERE source_chore_id = $1 ORDER BY debtor_id',
      [created.body.chore.id]
    );
    const members = await pool.query(
      'SELECT id FROM users WHERE household_id = $1 ORDER BY id',
      [fixture.householdId]
    );
    const baseShare = Math.floor(101 / members.rows.length);
    const remainder = 101 % members.rows.length;
    const expectedDebts = new Map(members.rows
      .map((member, index) => [member.id, baseShare + (index < remainder ? 1 : 0)])
      .filter(([memberId]) => memberId !== fixture.userId));

    assert.equal(response.status, 200);
    assert.equal(body.chore.settlement_type, 'household_iou');
    assert.equal(debts.rows.length, 2);
    assert.ok(debts.rows.every(debt => debt.creditor_id === fixture.userId));
    assert.deepEqual(new Map(debts.rows.map(debt => [debt.debtor_id, debt.amount_cents])), expectedDebts);
    assert.ok(debts.rows.every(debt => debt.source_chore_id === created.body.chore.id));

    const retry = await request(`/${created.body.chore.id}/complete`, {
      method: 'PATCH',
      token: fixture.token()
    });
    assert.equal(retry.status, 409);
    const repeatedDebts = await pool.query('SELECT id FROM ious WHERE source_chore_id = $1', [created.body.chore.id]);
    assert.equal(repeatedDebts.rows.length, 2);
  });

  test('lets a roommate pick up a chore and records household shares for the actual worker', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const firstRoommateId = await fixture.addMember('First roommate');
    const secondRoommateId = await fixture.addMember('Second roommate');
    const created = await createChore(fixture, {
      title: 'Clean the bathroom',
      price_cents: 800,
      assigned_to: fixture.userId
    });
    const choreId = created.body.chore.id;

    const unauthorizedOffer = await request(`/${choreId}/offer`, {
      method: 'POST',
      token: fixture.tokenFor(firstRoommateId)
    });
    assert.equal(unauthorizedOffer.status, 409);

    const offerResponse = await request(`/${choreId}/offer`, {
      method: 'POST',
      token: fixture.token()
    });
    assert.equal(offerResponse.status, 200);
    assert.equal((await offerResponse.json()).chore.assigned_to, null);

    const selfClaim = await request(`/${choreId}/claim`, {
      method: 'POST',
      token: fixture.token()
    });
    assert.equal(selfClaim.status, 409);

    const claimResponses = await Promise.all([
      request(`/${choreId}/claim`, { method: 'POST', token: fixture.tokenFor(firstRoommateId) }),
      request(`/${choreId}/claim`, { method: 'POST', token: fixture.tokenFor(secondRoommateId) })
    ]);
    assert.deepEqual(claimResponses.map(response => response.status).sort(), [200, 409]);
    const winnerResponse = claimResponses.find(response => response.status === 200);
    const winnerBody = await winnerResponse.json();
    const winnerId = winnerBody.chore.assigned_to.id;
    const loserId = winnerId === firstRoommateId ? secondRoommateId : firstRoommateId;

    const loserCompletion = await request(`/${choreId}/complete`, {
      method: 'PATCH',
      token: fixture.tokenFor(loserId)
    });
    assert.equal(loserCompletion.status, 409);

    const winnerCompletion = await request(`/${choreId}/complete`, {
      method: 'PATCH',
      token: fixture.tokenFor(winnerId)
    });
    assert.equal(winnerCompletion.status, 200);
    assert.equal((await winnerCompletion.json()).chore.status, 'completed');

    const payoutResponse = await fetch(endpoint.replace('/api/chores', '/api/payments/pay-chore'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.token()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ chore_id: choreId })
    });
    const payoutBody = await payoutResponse.json();
    assert.equal(payoutResponse.status, 409);
    assert.match(payoutBody.error, /household IOUs/);
    const debts = await pool.query(
      'SELECT debtor_id, creditor_id, amount_cents FROM ious WHERE source_chore_id = $1',
      [choreId]
    );
    const householdMembers = await pool.query(
      'SELECT id FROM users WHERE household_id = $1 ORDER BY id',
      [fixture.householdId]
    );
    const workerIndex = householdMembers.rows.findIndex(member => member.id === winnerId);
    const workerShare = Math.floor(800 / householdMembers.rows.length)
      + (workerIndex < 800 % householdMembers.rows.length ? 1 : 0);
    assert.ok(debts.rows.length > 0);
    assert.ok(debts.rows.every(debt => debt.creditor_id === winnerId));
    assert.equal(debts.rows.reduce((total, debt) => total + debt.amount_cents, 0), 800 - workerShare);
  });
}