const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { createApp } = require('../server.cjs');

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('Ledger integration tests require TEST_DATABASE_URL. Run them with npm test or npm run test:integration.');
} else {
  const secret = 'ledger-test-secret';
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
    endpoint = `http://127.0.0.1:${server.address().port}/api/ledger`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  });

  async function createFixture() {
    const householdIds = [];
    const userIds = [];
    const household = await pool.query(
      'INSERT INTO households (name, invite_code) VALUES ($1, $2) RETURNING id',
      ['Ledger integration test', randomUUID().replaceAll('-', '').slice(0, 12)]
    );
    const householdId = household.rows[0].id;
    householdIds.push(householdId);

    async function addUser(name, householdIdForUser = householdId) {
      const result = await pool.query(
        `INSERT INTO users (household_id, name, email, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [householdIdForUser, name, `${randomUUID()}@example.test`, 'not-used']
      );
      userIds.push(result.rows[0].id);
      return result.rows[0].id;
    }

    const meId = await addUser('Me');
    const roommateId = await addUser('Roommate');
    const thirdId = await addUser('Third roommate');
    const otherHousehold = await pool.query(
      'INSERT INTO households (name, invite_code) VALUES ($1, $2) RETURNING id',
      ['Other ledger household', randomUUID().replaceAll('-', '').slice(0, 12)]
    );
    householdIds.push(otherHousehold.rows[0].id);
    const outsiderId = await addUser('Outsider', otherHousehold.rows[0].id);

    await pool.query(
      `INSERT INTO transactions (payer_id, payee_id, amount_cents, note)
       VALUES ($1, $2, 725, 'Recorded wallet payment'), ($3, $4, 125, 'Other roommates payment')`,
      [meId, roommateId, roommateId, thirdId]
    );

    return {
      householdId,
      meId,
      roommateId,
      thirdId,
      outsiderId,
      async cleanup() {
        await pool.query(
          'DELETE FROM transactions WHERE payer_id = ANY($1::uuid[]) OR payee_id = ANY($1::uuid[])',
          [userIds]
        );
        await pool.query('DELETE FROM households WHERE id = ANY($1::uuid[])', [householdIds]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      }
    };
  }

  function authHeaders(userId) {
    return { Authorization: `Bearer ${jwt.sign({ id: userId }, secret)}` };
  }

  async function call(path, { userId, method = 'GET', body } = {}) {
    const headers = {};
    if (userId) Object.assign(headers, authHeaders(userId));
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { response, body: await response.json() };
  }

  async function createIou(fixture, overrides = {}) {
    return call('/ious', {
      userId: fixture.meId,
      method: 'POST',
      body: {
        debtor_id: fixture.meId,
        creditor_id: fixture.roommateId,
        amount_cents: 2500,
        description: 'Shared cleaning supplies',
        ...overrides
      }
    });
  }

  test('records IOUs, summarizes only pending debts, and lists only the viewer’s ledger entries', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);

    const created = await createIou(fixture);
    assert.equal(created.response.status, 201);
    assert.equal(created.body.iou.debtor_id, fixture.meId);
    assert.equal(created.body.iou.creditor_id, fixture.roommateId);
    assert.equal(created.body.iou.amount_cents, 2500);
    assert.equal(created.body.iou.created_by, fixture.meId);

    const debtorLedger = await call('', { userId: fixture.meId });
    assert.equal(debtorLedger.response.status, 200);
    assert.equal(debtorLedger.body.ious.length, 1);
    assert.equal(debtorLedger.body.ious[0].debtor_name, 'Me');
    assert.equal(debtorLedger.body.transactions.length, 1);
    assert.equal(debtorLedger.body.transactions[0].amount_cents, 725);
    assert.equal(debtorLedger.body.members.length, 2);

    const debtorSummary = await call('/summary', { userId: fixture.meId });
    assert.deepEqual(debtorSummary.body.summary, {
      owedToMe: 0,
      iOweOthers: 2500,
      netBalance: -2500,
      owesMe: [],
      iOwe: [{ to_user: fixture.roommateId, user_obj: { name: 'Roommate' }, total_cents: 2500 }]
    });

    const creditorSummary = await call('/summary', { userId: fixture.roommateId });
    assert.equal(creditorSummary.body.summary.owedToMe, 2500);
    assert.equal(creditorSummary.body.summary.iOweOthers, 0);
    assert.equal(creditorSummary.body.summary.owesMe[0].user_obj.name, 'Me');

    const otherRoommateLedger = await call('', { userId: fixture.thirdId });
    assert.equal(otherRoommateLedger.body.ious.length, 0);
    assert.equal(otherRoommateLedger.body.transactions.length, 1);
    assert.equal(otherRoommateLedger.body.transactions[0].amount_cents, 125);
  });

  test('rejects invalid IOUs and prevents cross-household visibility or creation', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);

    const invalidCases = [
      { amount_cents: 0 },
      { amount_cents: 1.5 },
      { debtor_id: fixture.meId, creditor_id: fixture.meId },
      { amount_cents: 2147483648 },
      { description: 'x'.repeat(256) }
    ];
    for (const overrides of invalidCases) {
      const { response, body } = await createIou(fixture, overrides);
      assert.equal(response.status, 400);
      assert.equal(typeof body.error, 'string');
    }

    const foreignMember = await createIou(fixture, { creditor_id: fixture.outsiderId });
    assert.equal(foreignMember.response.status, 400);

    const notParticipant = await call('/ious', {
      userId: fixture.thirdId,
      method: 'POST',
      body: { debtor_id: fixture.meId, creditor_id: fixture.roommateId, amount_cents: 100 }
    });
    assert.equal(notParticipant.response.status, 403);

    const created = await createIou(fixture);
    assert.equal(created.response.status, 201);
    const foreignLedger = await call('', { userId: fixture.outsiderId });
    assert.equal(foreignLedger.response.status, 200);
    assert.equal(foreignLedger.body.ious.length, 0);
    const hiddenIou = await call(`/ious/${created.body.iou.id}/paid`, { userId: fixture.outsiderId, method: 'PATCH' });
    assert.equal(hiddenIou.response.status, 404);
  });

  test('only the creditor can atomically confirm an IOU as paid; no wallet transaction is created', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const created = await createIou(fixture);
    const iouId = created.body.iou.id;

    const debtorAttempt = await call(`/ious/${iouId}/paid`, { userId: fixture.meId, method: 'PATCH' });
    assert.equal(debtorAttempt.response.status, 403);

    const settled = await call(`/ious/${iouId}/paid`, { userId: fixture.roommateId, method: 'PATCH' });
    assert.equal(settled.response.status, 200);
    assert.equal(settled.body.iou.status, 'paid');
    assert.ok(settled.body.iou.settled_at);

    const duplicate = await call(`/ious/${iouId}/paid`, { userId: fixture.roommateId, method: 'PATCH' });
    assert.equal(duplicate.response.status, 409);
    const summary = await call('/summary', { userId: fixture.meId });
    assert.equal(summary.body.summary.iOweOthers, 0);
    const transactions = await pool.query('SELECT count(*)::int AS count FROM transactions WHERE payer_id = $1 AND payee_id = $2', [fixture.meId, fixture.roommateId]);
    assert.equal(transactions.rows[0].count, 1);
  });

  test('concurrent creditor confirmations have exactly one winner', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    const created = await createIou(fixture);
    const path = `/ious/${created.body.iou.id}/paid`;
    const results = await Promise.all([
      call(path, { userId: fixture.roommateId, method: 'PATCH' }),
      call(path, { userId: fixture.roommateId, method: 'PATCH' })
    ]);
    assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
    const record = await pool.query('SELECT status, settled_at FROM ious WHERE id = $1', [created.body.iou.id]);
    assert.equal(record.rows[0].status, 'paid');
    assert.ok(record.rows[0].settled_at);
  });

  test('saves validated Venmo usernames and returns them for creditors and debtor payment handoffs', async t => {
    const fixture = await createFixture();
    t.after(fixture.cleanup);

    const invalid = await call('/venmo', {
      userId: fixture.roommateId,
      method: 'PATCH',
      body: { venmo_username: 'invalid/name' }
    });
    assert.equal(invalid.response.status, 400);

    const saved = await call('/venmo', {
      userId: fixture.roommateId,
      method: 'PATCH',
      body: { venmo_username: '@roommate-pay' }
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.venmo_username, 'roommate-pay');

    const created = await createIou(fixture);
    assert.equal(created.response.status, 201);
    assert.equal(created.body.iou.creditor_venmo_username, 'roommate-pay');
    const debtorLedger = await call('', { userId: fixture.meId });
    assert.equal(debtorLedger.body.venmo_username, '');
    assert.equal(debtorLedger.body.ious[0].creditor_venmo_username, 'roommate-pay');
    const creditorLedger = await call('', { userId: fixture.roommateId });
    assert.equal(creditorLedger.body.venmo_username, 'roommate-pay');
  });
}