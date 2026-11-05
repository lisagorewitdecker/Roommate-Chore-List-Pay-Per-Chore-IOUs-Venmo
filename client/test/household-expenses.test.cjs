const assert = require('node:assert/strict');
const test = require('node:test');
const { createHouseholdExpenseIous } = require('../controllers/householdExpenses.cjs');

function createRecordingClient(memberIds) {
  const inserts = [];
  const queries = [];
  return {
    inserts,
    queries,
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT id FROM users')) {
        return { rows: memberIds.map(id => ({ id })) };
      }
      inserts.push({ sql, values });
      return { rows: [] };
    }
  };
}

function expense(overrides = {}) {
  return {
    householdId: 'household-1',
    creditorId: 'member-a',
    amountCents: 1200,
    description: 'Shared expense',
    sourceType: 'chore',
    sourceId: 'source-1',
    ...overrides
  };
}

test('splits an even amount equally among household members except the creditor', async () => {
  const client = createRecordingClient(['member-a', 'member-b', 'member-c', 'member-d']);

  await createHouseholdExpenseIous(client, expense());

  assert.deepEqual(client.inserts.map(({ values }) => [values[1], values[3]]), [
    ['member-b', 300],
    ['member-c', 300],
    ['member-d', 300]
  ]);
});

test('assigns remainder cents in member order for an uneven split', async () => {
  const client = createRecordingClient(['member-a', 'member-b', 'member-c']);

  await createHouseholdExpenseIous(client, expense({ amountCents: 10 }));

  assert.deepEqual(client.inserts.map(({ values }) => [values[1], values[3]]), [
    ['member-b', 3],
    ['member-c', 3]
  ]);
});

test('uses the matching source column for chore and supply expenses', async () => {
  for (const [sourceType, sourceColumn] of [['chore', 'source_chore_id'], ['supply', 'source_supply_id']]) {
    const client = createRecordingClient(['member-a', 'member-b']);

    await createHouseholdExpenseIous(client, expense({ sourceType }));

    assert.match(client.inserts[0].sql, new RegExp(`created_by, ${sourceColumn}`));
    assert.deepEqual(client.inserts[0].values, [
      'household-1', 'member-b', 'member-a', 600, 'Shared expense', 'member-a', 'source-1'
    ]);
  }
});

test('assigns an explicit beneficiary the full amount and skips self-beneficiary IOUs', async () => {
  const client = createRecordingClient(['member-a', 'member-b', 'member-c']);

  await createHouseholdExpenseIous(client, expense({ amountCents: 825, beneficiaryId: 'member-c' }));

  assert.equal(client.inserts.length, 1);
  assert.deepEqual(client.inserts[0].values.slice(1, 4), ['member-c', 'member-a', 825]);

  const selfClient = createRecordingClient(['member-a', 'member-b']);
  await createHouseholdExpenseIous(selfClient, expense({ beneficiaryId: 'member-a' }));
  assert.equal(selfClient.inserts.length, 0);
});

test('skips zero-value shares when the amount is smaller than the household', async () => {
  const client = createRecordingClient(['member-a', 'member-b', 'member-c', 'member-d']);

  await createHouseholdExpenseIous(client, expense({ amountCents: 1, creditorId: 'member-d' }));

  assert.deepEqual(client.inserts.map(({ values }) => [values[1], values[3]]), [['member-a', 1]]);
});

test('rejects unsupported sources and creditors outside the household', async () => {
  const unsupportedSourceClient = createRecordingClient(['member-a', 'member-b']);
  await assert.rejects(
    createHouseholdExpenseIous(unsupportedSourceClient, expense({ sourceType: 'payment' })),
    /Unsupported household expense source/
  );
  assert.equal(unsupportedSourceClient.queries.length, 0);

  const outsiderCreditorClient = createRecordingClient(['member-a', 'member-b']);
  await assert.rejects(
    createHouseholdExpenseIous(outsiderCreditorClient, expense({ creditorId: 'outsider' })),
    /Expense creditor must belong to the household/
  );
  assert.equal(outsiderCreditorClient.inserts.length, 0);
});

test('rejects explicit beneficiaries outside the household', async () => {
  const client = createRecordingClient(['member-a', 'member-b']);

  await assert.rejects(
    createHouseholdExpenseIous(client, expense({ beneficiaryId: 'outsider' })),
    /Expense beneficiary must belong to the household/
  );
  assert.equal(client.inserts.length, 0);
});