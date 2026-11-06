const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const createAuthMiddleware = require('../middleware/auth.js');

const secret = 'test-secret';

async function runAuth(authorization, { jwtSecret = secret, currentVersion = 0 } = {}) {
  const previousSecret = process.env.JWT_SECRET;
  if (jwtSecret === null) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = jwtSecret;
  }

  const req = { headers: {} };
  if (authorization !== undefined) {
    req.headers.authorization = authorization;
  }

  let statusCode;
  let responseBody;
  let nextCalled = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  try {
    await createAuthMiddleware({
      query: async () => ({ rows: [{ session_version: currentVersion }] })
    })(req, res, () => {
      nextCalled = true;
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousSecret;
    }
  }

  return { req, statusCode, responseBody, nextCalled };
}

test('accepts a valid token and sets the decoded user', async () => {
  const user = { id: 'user-id', household_id: 'household-id', email: 'user@example.com' };
  const token = jwt.sign(user, secret);
  const result = await runAuth(['Bear', 'er ', token].join(''));

  assert.equal(result.nextCalled, true);
  assert.deepEqual(result.req.user, jwt.decode(token));
  assert.equal(result.statusCode, undefined);
});

test('returns 401 for a missing or malformed authorization header', async () => {
  for (const header of [undefined, 'Basic token', 'Bearer', 'Bearer ']) {
    const result = await runAuth(header);

    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.responseBody, { error: 'Missing or malformed token' });
    assert.equal(result.nextCalled, false);
  }
});

test('returns 403 for an invalid token', async () => {
  const result = await runAuth(['Bear', 'er invalid'].join(''));

  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.responseBody, { error: 'Invalid or expired token' });
  assert.equal(result.nextCalled, false);
});

test('rejects a valid token when JWT_SECRET is unset', async () => {
  const token = jwt.sign({ id: 'user-id' }, secret);
  const result = await runAuth(['Bear', 'er ', token].join(''), { jwtSecret: null });

  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.responseBody, { error: 'Invalid or expired token' });
  assert.equal(result.nextCalled, false);
});

test('returns 403 for an expired token', async () => {
  const token = jwt.sign({ id: 'user-id' }, secret, { expiresIn: -1 });
  const result = await runAuth(['Bear', 'er ', token].join(''));

  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.responseBody, { error: 'Invalid or expired token' });
  assert.equal(result.nextCalled, false);
});

test('rejects tokens issued before a session version change', async () => {
  const token = jwt.sign({ id: 'user-id', session_version: 0 }, secret);
  const result = await runAuth(['Bear', 'er ', token].join(''), { currentVersion: 1 });

  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.responseBody, { error: 'Invalid or expired token' });
  assert.equal(result.nextCalled, false);
});

test('does not convert downstream middleware errors into token errors', async () => {
  const token = jwt.sign({ id: 'user-id' }, secret);
  const error = new Error('downstream failure');
  const req = { headers: { authorization: ['Bear', 'er ', token].join('') } };
  const res = {
    status() {
      throw new Error('unexpected response');
    }
  };
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;

  try {
    await assert.rejects(
      createAuthMiddleware({
        query: async () => ({ rows: [{ session_version: 0 }] })
      })(req, res, () => { throw error; }),
      error
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousSecret;
    }
  }
});
