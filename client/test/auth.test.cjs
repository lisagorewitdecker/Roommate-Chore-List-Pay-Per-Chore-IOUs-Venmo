const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth.js');

const secret = 'test-secret';

function runAuth(authorization, jwtSecret = secret) {
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
    auth(req, res, () => {
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

test('accepts a valid Bearer token and sets the decoded user', () => {
  const user = { id: 'user-id', household_id: 'household-id', email: 'user@example.com' };
  const token = jwt.sign(user, secret);
  const result = runAuth(`Bearer ${token}`);

  assert.equal(result.nextCalled, true);
  assert.deepEqual(result.req.user, jwt.decode(token));
  assert.equal(result.statusCode, undefined);
});

test('returns 401 for a missing or malformed authorization header', () => {
  for (const header of [undefined, 'Basic token', 'Bearer', 'Bearer ']) {
    const result = runAuth(header);

    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.responseBody, { error: 'Missing or malformed token' });
    assert.equal(result.nextCalled, false);
  }
});

test('returns 403 for an invalid token', () => {
  const result = runAuth('Bearer invalid-token');

  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.responseBody, { error: 'Invalid or expired token' });
  assert.equal(result.nextCalled, false);
});

test('rejects a valid token when JWT_SECRET is unset', () => {
  const token = jwt.sign({ id: 'user-id' }, secret);
  const result = runAuth(`Bearer ${token}`, null);

  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.responseBody, { error: 'Invalid or expired token' });
  assert.equal(result.nextCalled, false);
});

test('returns 403 for an expired token', () => {
  const token = jwt.sign({ id: 'user-id' }, secret, { expiresIn: -1 });
  const result = runAuth(`Bearer ${token}`);

  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.responseBody, { error: 'Invalid or expired token' });
  assert.equal(result.nextCalled, false);
});

test('does not convert downstream middleware errors into token errors', () => {
  const token = jwt.sign({ id: 'user-id' }, secret);
  const error = new Error('downstream failure');
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = {
    status() {
      throw new Error('unexpected response');
    }
  };
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;

  try {
    assert.throws(() => auth(req, res, () => { throw error; }), error);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousSecret;
    }
  }
});