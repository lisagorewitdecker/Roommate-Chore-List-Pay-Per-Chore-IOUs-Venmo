const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createApp } = require('../server.cjs');

const secret = 'authentication-api-test-secret';

class MemoryPool {
  constructor({
    users = [],
    households = [],
    failOnUserInsert = false,
    forceDuplicateOnInsert = false,
    failOnRollback = false,
    failOnLoginQuery = false,
    failOnProfileQuery = false
  } = {}) {
    this.users = users;
    this.households = households;
    this.failOnUserInsert = failOnUserInsert;
    this.forceDuplicateOnInsert = forceDuplicateOnInsert;
    this.failOnRollback = failOnRollback;
    this.failOnLoginQuery = failOnLoginQuery;
    this.failOnProfileQuery = failOnProfileQuery;
    this.connectCount = 0;
    this.releaseCount = 0;
    this.queryLog = [];
  }

  async connect() {
    this.connectCount += 1;
    let transaction;

    return {
      query: async (sql, values = []) => {
        const query = sql.replace(/\s+/g, ' ').trim().toLowerCase();
        this.queryLog.push(query);

        if (query === 'begin') {
          transaction = { users: [], households: [] };
          return { rows: [] };
        }
        if (query === 'commit') {
          this.users.push(...transaction.users);
          this.households.push(...transaction.households);
          transaction = null;
          return { rows: [] };
        }
        if (query === 'rollback') {
          if (this.failOnRollback) throw new Error('injected rollback failure');
          transaction = null;
          return { rows: [] };
        }
        if (query.startsWith('select id from users where lower(email)')) {
          const email = values[0].toLowerCase();
          const user = [...this.users, ...(transaction?.users || [])].find(row => row.email.toLowerCase() === email);
          return { rows: user ? [{ id: user.id }] : [] };
        }
        if (query.startsWith('select id from households where invite_code')) {
          const code = values[0].toUpperCase();
          const household = [...this.households, ...(transaction?.households || [])].find(row => row.invite_code === code);
          return { rows: household ? [{ id: household.id }] : [] };
        }
        if (query.startsWith('insert into households')) {
          const household = { id: randomUUID(), name: values[0], invite_code: values[1] };
          transaction.households.push(household);
          return { rows: [{ id: household.id }] };
        }
        if (query.startsWith('insert into users')) {
          if (this.failOnUserInsert) throw new Error('injected user insert failure');
          if (this.forceDuplicateOnInsert) {
            const error = new Error('duplicate user email');
            error.code = '23505';
            error.constraint = 'users_email_lower_idx';
            throw error;
          }
          const [name, email, password_hash, household_id] = values;
          const user = {
            id: randomUUID(),
            name,
            email,
            password_hash,
            household_id,
            balance_cents: 0,
            session_version: 0,
            created_at: new Date().toISOString()
          };
          transaction.users.push(user);
          return { rows: [{ ...user }] };
        }
        throw new Error(`Unexpected client query: ${query}`);
      },
      release: () => {
        this.releaseCount += 1;
      }
    };
  }

  async query(sql, values = []) {
    const query = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.queryLog.push(query);

    if (query.startsWith('select id, name, email, password_hash')) {
      if (this.failOnLoginQuery) throw new Error('injected login query failure');
      const email = values[0].toLowerCase();
      const user = this.users.find(row => row.email.toLowerCase() === email);
      return { rows: user ? [{ ...user }] : [] };
    }
    if (query.startsWith('select session_version from users')) {
      const user = this.users.find(row => row.id === values[0]);
      return { rows: user ? [{ session_version: user.session_version ?? 0 }] : [] };
    }
    if (query.startsWith('select u.id')) {
      if (this.failOnProfileQuery) throw new Error('injected profile query failure');
      const user = this.users.find(row => row.id === values[0]);
      if (!user) return { rows: [] };
      const household = this.households.find(row => row.id === user.household_id);
      return {
        rows: [{
          id: user.id,
          name: user.name,
          email: user.email,
          balance_cents: user.balance_cents,
          household_id: user.household_id,
          household_name: household?.name ?? null,
          household_invite_code: household?.invite_code ?? null
        }]
      };
    }
    throw new Error(`Unexpected pool query: ${query}`);
  }
}

async function withApi(pool, callback, jwtSecret = secret) {
  const previousSecret = process.env.JWT_SECRET;
  if (jwtSecret === null) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = jwtSecret;
  }

  const server = createApp({ pool }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousSecret;
    }
  }
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test('registers a user and creates a household in one transaction without exposing the hash', async () => {
  const pool = new MemoryPool();

  await withApi(pool, async baseUrl => {
    const { response, body } = await post(baseUrl, '/api/auth/register', {
      name: '  Alex Example  ',
      email: ' Alex@Example.com ',
      password: 'password123',
      household_name: '  Shared Home  '
    });

    assert.equal(response.status, 201);
    assert.equal(body.message, 'User registered successfully');
    assert.deepEqual(body.user, {
      id: pool.users[0].id,
      name: 'Alex Example',
      email: 'alex@example.com',
      household_id: pool.households[0].id,
      balance_cents: 0
    });
    assert.equal(Object.hasOwn(body.user, 'password_hash'), false);
    assert.equal(pool.users[0].password_hash === 'password123', false);
    assert.equal(await bcrypt.compare('password123', pool.users[0].password_hash), true);
    assert.equal(pool.households[0].name, 'Shared Home');
    assert.match(pool.households[0].invite_code, /^[A-F0-9]{12}$/);
    assert.deepEqual(jwt.verify(body.token, secret), {
      id: pool.users[0].id,
      email: 'alex@example.com',
      household_id: pool.households[0].id,
      session_version: 0,
      iat: jwt.decode(body.token).iat,
      exp: jwt.decode(body.token).exp
    });
    assert.equal(pool.queryLog.includes('commit'), true);
    assert.equal(pool.releaseCount, 1);
  });
});

test('registration joins an existing household using a normalized invite code', async () => {
  const household = { id: randomUUID(), name: 'Existing Home', invite_code: 'ABCDEF123456' };
  const pool = new MemoryPool({ households: [household] });

  await withApi(pool, async baseUrl => {
    const { response, body } = await post(baseUrl, '/api/auth/register', {
      name: 'Roommate',
      email: 'roommate@example.com',
      password: 'password123',
      invite_code: ' abcdef123456 '
    });

    assert.equal(response.status, 201);
    assert.equal(body.user.household_id, household.id);
    assert.equal(pool.households.length, 1);
  });
});

test('registration rejects unknown invite codes and truncates a generated household title to the schema limit', async () => {
  const pool = new MemoryPool();

  await withApi(pool, async baseUrl => {
    const invalidInvite = await post(baseUrl, '/api/auth/register', {
      name: 'Roommate', email: 'invalid-invite@example.com', password: 'password123', invite_code: 'MISSING'
    });
    assert.equal(invalidInvite.response.status, 404);
    assert.equal(pool.queryLog.includes('rollback'), true);
    assert.equal(pool.households.length, 0);

    const longName = await post(baseUrl, '/api/auth/register', {
      name: 'N'.repeat(100), email: 'long-name@example.com', password: 'password123'
    });
    assert.equal(longName.response.status, 201);
    assert.equal(pool.households[0].name.length, 100);
  });
});

test('registration validates input before acquiring a database client', async () => {
  const pool = new MemoryPool();
  const cases = [
    { body: {}, error: 'Name, email, and password are required' },
    { body: { name: 'Name', email: 'invalid-email', password: 'password123' }, error: 'Please provide a valid email address' },
    { body: { name: 'Name', email: 'name@example.com', password: 'short' }, error: 'Password must be at least 8 characters long' },
    { body: { name: 'Name', email: 'name@example.com', password: 'é'.repeat(37) }, error: 'Password must not exceed 72 bytes' },
    { body: { name: 'x'.repeat(101), email: 'name@example.com', password: 'password123' }, error: 'Name must be between 1 and 100 characters' },
    { body: { name: 'Name', email: 'name@example.com', password: 'password123', household_name: 42 }, error: 'Household name must be text' },
    { body: { name: 'Name', email: 'name@example.com', password: 'password123', household_name: 'H'.repeat(101) }, error: 'Household name must not exceed 100 characters' },
    { body: { name: 'Name', email: 'name@example.com', password: 'password123', invite_code: 42 }, error: 'Invite code must be text' },
    { body: { name: 'Name', email: 'name@example.com', password: 'password123', invite_code: 'X'.repeat(13) }, error: 'Invite code is invalid' }
  ];

  for (const item of cases) {
    await withApi(pool, async baseUrl => {
      const { response, body } = await post(baseUrl, '/api/auth/register', item.body);
      assert.equal(response.status, 400);
      assert.deepEqual(body, { error: item.error });
    });
  }

  assert.equal(pool.connectCount, 0);
});

test('registration releases its client when both the insert and rollback fail', async () => {
  const pool = new MemoryPool({ failOnUserInsert: true, failOnRollback: true });

  await withApi(pool, async baseUrl => {
    const { response, body } = await post(baseUrl, '/api/auth/register', {
      name: 'Roommate', email: 'roommate@example.com', password: 'password123'
    });

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: 'Registration failed due to an internal server error' });
  });

  assert.equal(pool.queryLog.includes('rollback'), true);
  assert.equal(pool.releaseCount, 1);
  assert.equal(pool.users.length, 0);
  assert.equal(pool.households.length, 0);
});

test('duplicate registration returns conflict and rolls back/releases its client', async () => {
  const pool = new MemoryPool({ users: [{
    id: randomUUID(), name: 'Existing', email: 'existing@example.com', password_hash: 'hash', household_id: null
  }] });

  await withApi(pool, async baseUrl => {
    const { response, body } = await post(baseUrl, '/api/auth/register', {
      name: 'Existing Again', email: 'EXISTING@example.com', password: 'password123'
    });

    assert.equal(response.status, 409);
    assert.deepEqual(body, { error: 'An account with this email already exists' });
  });

  assert.equal(pool.queryLog.includes('rollback'), true);
  assert.equal(pool.releaseCount, 1);
});

test('concurrent duplicate-email constraint failures are returned as conflicts', async () => {
  const pool = new MemoryPool({ forceDuplicateOnInsert: true });

  await withApi(pool, async baseUrl => {
    const { response, body } = await post(baseUrl, '/api/auth/register', {
      name: 'Roommate', email: 'roommate@example.com', password: 'password123'
    });

    assert.equal(response.status, 409);
    assert.deepEqual(body, { error: 'An account with this email already exists' });
  });

  assert.equal(pool.users.length, 0);
  assert.equal(pool.households.length, 0);
  assert.equal(pool.queryLog.includes('rollback'), true);
  assert.equal(pool.releaseCount, 1);
});

test('login uses a generic credential error and profile returns only safe user fields', async () => {
  const household = { id: randomUUID(), name: 'Shared Home', invite_code: 'A1B2C3D4E5F6' };
  const user = {
    id: randomUUID(),
    name: 'Alex',
    email: 'alex@example.com',
    password_hash: await bcrypt.hash('correct-password', 4),
    household_id: household.id,
    balance_cents: 1234,
    session_version: 0
  };
  const pool = new MemoryPool({ users: [user], households: [household] });

  await withApi(pool, async baseUrl => {
    const badLogin = await post(baseUrl, '/api/auth/login', { email: user.email, password: 'wrong-password' });
    assert.equal(badLogin.response.status, 401);
    assert.deepEqual(badLogin.body, { error: 'Invalid email or password' });

    const overlongPassword = await post(baseUrl, '/api/auth/login', {
      email: user.email,
      password: `${'x'.repeat(72)}suffix`
    });
    assert.equal(overlongPassword.response.status, 400);

    const login = await post(baseUrl, '/api/auth/login', { email: ' ALEX@example.com ', password: 'correct-password' });
    assert.equal(login.response.status, 200);
    assert.equal(Object.hasOwn(login.body.user, 'password_hash'), false);

    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${login.body.token}` }
    });
    const profile = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(profile.user, {
      id: user.id,
      name: user.name,
      email: user.email,
      balance_cents: 1234,
      formatted_balance: '$12.34',
      household: { id: household.id, name: household.name, invite_code: household.invite_code }
    });
  });
});

test('login validates required credentials and email format before querying the database', async () => {
  const pool = new MemoryPool();

  await withApi(pool, async baseUrl => {
    for (const body of [{}, { email: ' ', password: 'password123' }, { email: 'user@example.com', password: '' }]) {
      const { response, body: result } = await post(baseUrl, '/api/auth/login', body);
      assert.equal(response.status, 400);
      assert.deepEqual(result, { error: 'Email and password are required' });
    }

    const invalidEmail = await post(baseUrl, '/api/auth/login', {
      email: 'invalid-email', password: 'password123'
    });
    assert.equal(invalidEmail.response.status, 400);
    assert.deepEqual(invalidEmail.body, { error: 'Please provide a valid email address' });
  });

  assert.equal(pool.queryLog.length, 0);
});

test('login returns a safe server error when the user query fails', async () => {
  const pool = new MemoryPool({ failOnLoginQuery: true });

  await withApi(pool, async baseUrl => {
    const { response, body } = await post(baseUrl, '/api/auth/login', {
      email: 'user@example.com', password: 'password123'
    });

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: 'Internal server error during authentication' });
  });
});

test('profile rejects an invalid authenticated user and reports a missing profile', async () => {
  const pool = new MemoryPool();

  await withApi(pool, async baseUrl => {
    const invalidUserToken = jwt.sign({ id: 123 }, secret);
    const invalidUserResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${invalidUserToken}` }
    });
    assert.equal(invalidUserResponse.status, 401);
    assert.deepEqual(await invalidUserResponse.json(), { error: 'Invalid authenticated user' });

    const missingProfileToken = jwt.sign({ id: randomUUID() }, secret);
    const missingProfileResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${missingProfileToken}` }
    });
    assert.equal(missingProfileResponse.status, 403);
    assert.deepEqual(await missingProfileResponse.json(), { error: 'Invalid or expired token' });
  });
});

test('profile returns a safe server error when the user query fails', async () => {
  const user = { id: randomUUID(), session_version: 0 };
  const pool = new MemoryPool({ users: [user], failOnProfileQuery: true });
  const token = jwt.sign({ id: user.id }, secret);

  await withApi(pool, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Failed to retrieve profile' });
  });
});

test('profile distinguishes missing, invalid, and expired JWTs', async () => {
  const pool = new MemoryPool();

  await withApi(pool, async baseUrl => {
    const cases = [
      { authorization: undefined, status: 401, error: 'Missing or malformed token' },
      { authorization: 'Basic token', status: 401, error: 'Missing or malformed token' },
      { authorization: 'Bearer forged-token', status: 403, error: 'Invalid or expired token' },
      { authorization: `Bearer ${jwt.sign({ id: 'user-id' }, secret, { expiresIn: -1 })}`, status: 403, error: 'Invalid or expired token' }
    ];

    for (const item of cases) {
      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: item.authorization ? { Authorization: item.authorization } : {}
      });
      assert.equal(response.status, item.status);
      assert.deepEqual(await response.json(), { error: item.error });
    }
  });
});

test('registration rolls back on database and token-signing failures', async () => {
  const failedInsertPool = new MemoryPool({ failOnUserInsert: true });
  await withApi(failedInsertPool, async baseUrl => {
    const { response } = await post(baseUrl, '/api/auth/register', {
      name: 'Roommate', email: 'roommate@example.com', password: 'password123'
    });
    assert.equal(response.status, 500);
  });
  assert.equal(failedInsertPool.queryLog.includes('rollback'), true);
  assert.equal(failedInsertPool.releaseCount, 1);
  assert.equal(failedInsertPool.users.length, 0);
  assert.equal(failedInsertPool.households.length, 0);

  const signingFailurePool = new MemoryPool();
  await withApi(signingFailurePool, async baseUrl => {
    const { response } = await post(baseUrl, '/api/auth/register', {
      name: 'Roommate', email: 'roommate@example.com', password: 'password123'
    });
    assert.equal(response.status, 500);
  }, null);
  assert.equal(signingFailurePool.queryLog.includes('rollback'), true);
  assert.equal(signingFailurePool.releaseCount, 1);
  assert.equal(signingFailurePool.users.length, 0);
  assert.equal(signingFailurePool.households.length, 0);
});

test('registration and login have independent rate limits and do not reach the database after blocking', async () => {
  const pool = new MemoryPool();

  await withApi(pool, async baseUrl => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await post(baseUrl, '/api/auth/register', {
        name: 'Roommate', email: `roommate-${attempt}@example.com`, password: 'password123'
      });
      assert.equal(result.response.status, 201);
    }

    const connectCountAfterRegistrations = pool.connectCount;
    const registrationLimit = await post(baseUrl, '/api/auth/register', {
      name: 'Roommate', email: 'blocked@example.com', password: 'password123'
    });
    assert.equal(registrationLimit.response.status, 429);
    assert.deepEqual(registrationLimit.body, { error: 'Too many registration attempts. Please try again later.' });
    assert.equal(registrationLimit.response.headers.get('ratelimit-limit'), '5');
    assert.match(registrationLimit.response.headers.get('retry-after'), /^\d+$/);
    assert.equal(pool.connectCount, connectCountAfterRegistrations);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await post(baseUrl, '/api/auth/login', {
        email: 'missing@example.com', password: 'password123'
      });
      assert.equal(result.response.status, 401);
    }

    const queryCountAfterLogins = pool.queryLog.length;
    const loginLimit = await post(baseUrl, '/api/auth/login', {
      email: 'missing@example.com', password: 'password123'
    });
    assert.equal(loginLimit.response.status, 429);
    assert.deepEqual(loginLimit.body, { error: 'Too many login attempts. Please try again later.' });
    assert.equal(loginLimit.response.headers.get('ratelimit-limit'), '5');
    assert.match(loginLimit.response.headers.get('retry-after'), /^\d+$/);
    assert.equal(pool.queryLog.length, queryCountAfterLogins);
  });
});

test('health endpoint responds and exposes the configured client origin through CORS', async () => {
  const pool = new MemoryPool();
  const previousOrigin = process.env.CLIENT_ORIGIN;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';

  try {
    await withApi(pool, async baseUrl => {
      const response = await fetch(`${baseUrl}/health`, { headers: { Origin: 'http://localhost:5173' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.equal((await response.json()).status, 'ok');
    });
  } finally {
    if (previousOrigin === undefined) delete process.env.CLIENT_ORIGIN;
    else process.env.CLIENT_ORIGIN = previousOrigin;
  }
});