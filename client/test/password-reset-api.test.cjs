const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const bcrypt = require('bcrypt');
const { createApp } = require('../server.cjs');

const secret = 'password-reset-api-test-secret';

class PasswordResetMemoryPool {
  constructor(users = []) {
    this.users = users;
    this.queryLog = [];
  }

  async query(sql, values = []) {
    const query = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.queryLog.push(query);
    if (query.startsWith('select id, email from users')) {
      const email = values[0].toLowerCase();
      const user = this.users.find(row => row.email.toLowerCase() === email);
      return { rows: user ? [{ id: user.id, email: user.email }] : [] };
    }
    if (query.startsWith('update users set password_reset_token_hash')) {
      const [tokenHash, userId] = values;
      const user = this.users.find(row => row.id === userId);
      if (!user) return { rows: [] };
      user.password_reset_token_hash = tokenHash;
      user.password_reset_token_expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return { rows: [] };
    }
    if (query.startsWith('update users set password_hash')) {
      const [passwordHash, tokenHash] = values;
      const user = this.users.find(row => row.password_reset_token_hash === tokenHash
        && new Date(row.password_reset_token_expires_at).getTime() > Date.now());
      if (!user) return { rows: [] };
      user.password_hash = passwordHash;
      user.password_reset_token_hash = null;
      user.password_reset_token_expires_at = null;
      return { rows: [{ id: user.id }] };
    }
    if (query.startsWith('select id, name, email, password_hash')) {
      const email = values[0].toLowerCase();
      const user = this.users.find(row => row.email.toLowerCase() === email);
      return { rows: user ? [{ ...user }] : [] };
    }
    throw new Error(`Unexpected pool query: ${query}`);
  }
}

async function withApi(pool, callback, options = {}) {
  const previousSecret = process.env.JWT_SECRET;
  const previousOrigin = process.env.CLIENT_ORIGIN;
  const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
  const previousSmtpConfig = Object.fromEntries(smtpKeys.map(key => [key, process.env[key]]));
  process.env.JWT_SECRET = secret;
  process.env.CLIENT_ORIGIN = 'https://roommates.example';
  for (const key of smtpKeys) delete process.env[key];
  const server = createApp({ pool, ...options }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousOrigin === undefined) delete process.env.CLIENT_ORIGIN;
    else process.env.CLIENT_ORIGIN = previousOrigin;
    for (const key of smtpKeys) {
      if (previousSmtpConfig[key] === undefined) delete process.env[key];
      else process.env[key] = previousSmtpConfig[key];
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

function makeUser(overrides = {}) {
  return {
    id: randomUUID(),
    name: 'Alex Example',
    email: 'alex@example.com',
    password_hash: bcrypt.hashSync('old-password', 4),
    household_id: randomUUID(),
    balance_cents: 0,
    password_reset_token_hash: null,
    password_reset_token_expires_at: null,
    ...overrides
  };
}

test('password reset requests send a hashed, expiring token without revealing whether an email exists', async () => {
  const user = makeUser();
  const pool = new PasswordResetMemoryPool([user]);
  const delivered = [];
  const sendPasswordResetEmail = async email => delivered.push(email);

  await withApi(pool, async baseUrl => {
    const known = await post(baseUrl, '/api/auth/password-reset/request', { email: ' ALEX@example.com ' });
    const unknown = await post(baseUrl, '/api/auth/password-reset/request', { email: 'unknown@example.com' });

    assert.equal(known.response.status, 200);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(known.body.message, 'If an account exists for that email, a password reset link has been sent.');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].to, user.email);

    const link = new URL(delivered[0].resetUrl);
    assert.equal(link.origin, 'https://roommates.example');
    assert.equal(link.pathname, '/reset-password');
    const token = link.searchParams.get('token');
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(user.password_reset_token_hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(user.password_reset_token_hash, token);
    assert.ok(new Date(user.password_reset_token_expires_at).getTime() > Date.now());
    assert.ok(new Date(user.password_reset_token_expires_at).getTime() <= Date.now() + 60 * 60 * 1000);
  }, { sendPasswordResetEmail, passwordResetEmailConfigured: () => true });
});

test('password reset validates tokens and passwords, consumes the token, and permits login with the new password', async () => {
  const user = makeUser();
  const expiredTokenHash = createHash('sha256').update('b'.repeat(64)).digest('hex');
  const expiredUser = makeUser({
    email: 'expired@example.com',
    password_reset_token_hash: expiredTokenHash,
    password_reset_token_expires_at: new Date(Date.now() - 1000).toISOString()
  });
  const pool = new PasswordResetMemoryPool([user, expiredUser]);
  let resetUrl;

  await withApi(pool, async baseUrl => {
    await post(baseUrl, '/api/auth/password-reset/request', { email: user.email });
    const token = new URL(resetUrl).searchParams.get('token');

    const tooShort = await post(baseUrl, '/api/auth/password-reset/complete', { token, password: 'short' });
    assert.equal(tooShort.response.status, 400);
    assert.equal(user.password_reset_token_hash, createHash('sha256').update(token).digest('hex'));

    const tooLong = await post(baseUrl, '/api/auth/password-reset/complete', { token, password: 'é'.repeat(37) });
    assert.equal(tooLong.response.status, 400);

    const invalid = await post(baseUrl, '/api/auth/password-reset/complete', { token: 'not-a-token', password: 'new-password' });
    assert.equal(invalid.response.status, 400);
    assert.deepEqual(invalid.body, { error: 'Invalid or expired password reset link' });

    const expired = await post(baseUrl, '/api/auth/password-reset/complete', {
      token: 'b'.repeat(64), password: 'new-password'
    });
    assert.equal(expired.response.status, 400);
    assert.deepEqual(expired.body, { error: 'Invalid or expired password reset link' });

  }, {
    sendPasswordResetEmail: async email => { resetUrl = email.resetUrl; },
    passwordResetEmailConfigured: () => true
  });

  await withApi(pool, async baseUrl => {
    await post(baseUrl, '/api/auth/password-reset/request', { email: user.email });
    const token = new URL(resetUrl).searchParams.get('token');
    const completed = await post(baseUrl, '/api/auth/password-reset/complete', { token, password: 'new-password' });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.message, 'Password has been reset. You can now sign in.');
    assert.equal(user.password_reset_token_hash, null);
    assert.equal(user.password_reset_token_expires_at, null);
    assert.equal(await bcrypt.compare('new-password', user.password_hash), true);

    const reused = await post(baseUrl, '/api/auth/password-reset/complete', { token, password: 'another-password' });
    assert.equal(reused.response.status, 400);

    const oldLogin = await post(baseUrl, '/api/auth/login', { email: user.email, password: 'old-password' });
    assert.equal(oldLogin.response.status, 401);
    const newLogin = await post(baseUrl, '/api/auth/login', { email: user.email, password: 'new-password' });
    assert.equal(newLogin.response.status, 200);
  }, {
    sendPasswordResetEmail: async email => { resetUrl = email.resetUrl; },
    passwordResetEmailConfigured: () => true
  });
});

test('password reset rejects malformed input, reports missing mail configuration, and rate-limits requests', async () => {
  const pool = new PasswordResetMemoryPool([makeUser()]);

  await withApi(pool, async baseUrl => {
    const invalidEmail = await post(baseUrl, '/api/auth/password-reset/request', { email: 'not-an-email' });
    assert.equal(invalidEmail.response.status, 400);

    const missingEmail = await post(baseUrl, '/api/auth/password-reset/request', {});
    assert.equal(missingEmail.response.status, 400);

    const noToken = await post(baseUrl, '/api/auth/password-reset/complete', { password: 'new-password' });
    assert.equal(noToken.response.status, 400);

    const noMailer = await post(baseUrl, '/api/auth/password-reset/request', { email: 'alex@example.com' });
    assert.equal(noMailer.response.status, 503);
    assert.match(noMailer.body.error, /SMTP/);
  });

  await withApi(pool, async baseUrl => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await post(baseUrl, '/api/auth/password-reset/request', { email: 'unknown@example.com' });
      assert.equal(result.response.status, 200);
    }

    const invalidComplete = await post(baseUrl, '/api/auth/password-reset/complete', {
      token: 'a'.repeat(64), password: 'new-password'
    });
    assert.equal(invalidComplete.response.status, 400);

    const queryCountBeforeBlockedRequest = pool.queryLog.length;
    const limited = await post(baseUrl, '/api/auth/password-reset/request', { email: 'unknown@example.com' });
    assert.equal(limited.response.status, 429);
    assert.deepEqual(limited.body, {
      error: 'Too many password reset requests. Please try again later.'
    });
    assert.equal(limited.response.headers.get('ratelimit-limit'), '5');
    assert.match(limited.response.headers.get('retry-after'), /^\d+$/);
    assert.equal(pool.queryLog.length, queryCountBeforeBlockedRequest);
  }, {
    sendPasswordResetEmail: async () => {},
    passwordResetEmailConfigured: () => true
  });
});