const assert = require('node:assert/strict');
const test = require('node:test');
const { createPaymentController } = require('../controllers/paymentController.cjs');

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('rejects invalid chore and authenticated user IDs without acquiring a client', async () => {
  let connectCount = 0;
  const controller = createPaymentController({
    async connect() {
      connectCount += 1;
      throw new Error('unexpected database connection');
    }
  });

  const invalidChoreResponse = createResponse();
  await controller({ body: { chore_id: 'not-a-uuid' }, user: { id: '550e8400-e29b-41d4-a716-446655440000' } }, invalidChoreResponse);
  assert.equal(invalidChoreResponse.statusCode, 400);
  assert.deepEqual(invalidChoreResponse.body, { error: 'A valid chore ID is required' });

  const invalidUserResponse = createResponse();
  await controller({ body: { chore_id: '550e8400-e29b-41d4-a716-446655440000' }, user: { id: 'invalid-user-id' } }, invalidUserResponse);
  assert.equal(invalidUserResponse.statusCode, 401);
  assert.deepEqual(invalidUserResponse.body, { error: 'Invalid authenticated user' });
  assert.equal(connectCount, 0);
});

test('reports payment failure and releases the client when rollback also fails', async () => {
  const queries = [];
  let releaseCount = 0;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          const query = sql.replace(/\s+/g, ' ').trim().toLowerCase();
          queries.push(query);
          if (query.startsWith('select * from chores')) throw new Error('injected chore query failure');
          if (query === 'rollback') throw new Error('injected rollback failure');
          return { rows: [] };
        },
        release() {
          releaseCount += 1;
        }
      };
    }
  };
  const controller = createPaymentController(pool);
  const response = createResponse();

  await controller({
    body: { chore_id: '550e8400-e29b-41d4-a716-446655440000' },
    user: { id: '550e8400-e29b-41d4-a716-446655440001' }
  }, response);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: 'Unable to process payment' });
  assert.deepEqual(queries, ['begin', 'select * from chores where id = $1 for update', 'rollback']);
  assert.equal(releaseCount, 1);
});