const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { gzipSync } = require('node:zlib');
const jwt = require('jsonwebtoken');
const { createApp } = require('../server.cjs');

const projectRoot = path.resolve(__dirname, '..');

async function withClientOrigin(origin, action) {
  const hadClientOrigin = Object.hasOwn(process.env, 'CLIENT_ORIGIN');
  const previousClientOrigin = process.env.CLIENT_ORIGIN;
  if (origin === undefined) delete process.env.CLIENT_ORIGIN;
  else process.env.CLIENT_ORIGIN = origin;

  try {
    return await action();
  } finally {
    if (hadClientOrigin) process.env.CLIENT_ORIGIN = previousClientOrigin;
    else delete process.env.CLIENT_ORIGIN;
  }
}

async function withJwtSecret(secret, action) {
  const hadJwtSecret = Object.hasOwn(process.env, 'JWT_SECRET');
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;

  try {
    return await action();
  } finally {
    if (hadJwtSecret) process.env.JWT_SECRET = previousJwtSecret;
    else delete process.env.JWT_SECRET;
  }
}

async function withGeminiApiKey(apiKey, action) {
  const hadApiKey = Object.hasOwn(process.env, 'GEMINI_API_KEY');
  const previousApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = apiKey;

  try {
    return await action();
  } finally {
    if (hadApiKey) process.env.GEMINI_API_KEY = previousApiKey;
    else delete process.env.GEMINI_API_KEY;
  }
}

function spawnServer(port, { stubListen = false } = {}) {
  const env = { ...process.env, JWT_SECRET: 'server-startup-test-secret' };
  if (port === undefined) delete env.PORT;
  else env.PORT = String(port);

  const args = [];
  if (stubListen) args.push('--require', path.join(__dirname, 'server-listen-stub.cjs'));
  args.push(path.join(projectRoot, 'server.cjs'));

  return spawn(process.execPath, args, {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server;
}

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => finish(new Error(`Server did not start. Output: ${output}`)), 5000);

    function onData(chunk) {
      output += chunk.toString();
      if (output.includes('Payment API listening on port')) finish();
    }

    function onExit(code, signal) {
      finish(new Error(`Server exited before startup (code ${code}, signal ${signal}). Output: ${output}`));
    }

    function onError(error) {
      finish(error);
    }

    function finish(error) {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(output);
    }

    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timeout;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Server child did not stop after SIGTERM')), 3000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('malformed JSON receives a client error response', async () => {
  const server = await listen(createApp({ pool: {} }));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{'
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid request body' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('API routes are rate-limited without affecting health checks', async () => {
  const server = await listen(createApp({ pool: {} }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (let request = 0; request < 100; request += 1) {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      assert.equal(response.status, 401);
    }

    const limitedResponse = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(limitedResponse.status, 429);

    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('all mounted protected routes reject missing and invalid tokens before calling dependencies', async () => {
  await withJwtSecret('server-route-test-secret', async () => {
    let poolCalls = 0;
    let aiFactoryCalls = 0;
    const app = createApp({
      pool: {
        async query() {
          poolCalls += 1;
          throw new Error('protected route reached the pool');
        },
        async connect() {
          poolCalls += 1;
          throw new Error('protected route reached the pool');
        }
      },
      aiClientFactory() {
        aiFactoryCalls += 1;
        throw new Error('protected route reached the AI client');
      }
    });
    const server = await listen(app);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const protectedRequests = [
      { method: 'GET', path: '/api/auth/me' },
      { method: 'POST', path: '/api/payments/pay-chore', body: { chore_id: '11111111-1111-4111-8111-111111111111' } },
      { method: 'POST', path: '/api/ai/estimate-price', body: { title: 'Clean kitchen', description: 'Wipe surfaces' } }
    ];

    try {
      for (const request of protectedRequests) {
        for (const authorization of [undefined, 'Bearer invalid-token']) {
          const response = await fetch(`${baseUrl}${request.path}`, {
            method: request.method,
            headers: {
              ...(authorization ? { Authorization: authorization } : {}),
              ...(request.body ? { 'Content-Type': 'application/json' } : {})
            },
            ...(request.body ? { body: JSON.stringify(request.body) } : {})
          });
          const missingToken = authorization === undefined;

          assert.equal(response.status, missingToken ? 401 : 403);
          assert.deepEqual(await response.json(), {
            error: missingToken ? 'Missing or malformed token' : 'Invalid or expired token'
          });
        }
      }

      assert.equal(poolCalls, 0);
      assert.equal(aiFactoryCalls, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('authenticated profile and payment routes use the injected pool', async () => {
  await withJwtSecret('server-route-test-secret', async () => {
    const payerId = '11111111-1111-4111-8111-111111111111';
    const payeeId = '22222222-2222-4222-8222-222222222222';
    const householdId = '33333333-3333-4333-8333-333333333333';
    const choreId = '44444444-4444-4444-8444-444444444444';
    const calls = [];
    let releaseCount = 0;
    const injectedPool = {
      async query(sql, params) {
        calls.push({ kind: 'pool.query', sql, params });
        if (sql.includes('SELECT session_version')) {
          return { rows: [{ session_version: 0 }] };
        }
        assert.match(sql, /FROM users u/);
        return {
          rows: [{
            id: payerId,
            name: 'Payer',
            email: 'payer@example.com',
            balance_cents: 1000,
            household_id: householdId,
            household_name: 'Test home',
            household_invite_code: 'INVITE42'
          }]
        };
      },
      async connect() {
        calls.push({ kind: 'pool.connect' });
        return {
          async query(sql, params) {
            calls.push({ kind: 'client.query', sql, params });
            if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
            if (sql.startsWith('SELECT * FROM chores')) {
              return {
                rows: [{
                  id: choreId,
                  title: 'Wash dishes',
                  status: 'completed',
                  assigned_to: payeeId,
                  price_cents: 400,
                  household_id: householdId
                }]
              };
            }
            if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
              return {
                rows: [
                  { id: payerId, household_id: householdId, balance_cents: 1000 },
                  { id: payeeId, household_id: householdId, balance_cents: 0 }
                ]
              };
            }
            if (sql.startsWith('INSERT INTO transactions')) {
              return { rows: [{ id: 'transaction-1', amount_cents: 400 }] };
            }
            if (sql.startsWith('UPDATE users') || sql.startsWith('UPDATE chores')) return { rows: [] };
            throw new Error(`Unexpected payment query: ${sql}`);
          },
          release() {
            releaseCount += 1;
          }
        };
      }
    };
    const token = jwt.sign({ id: payerId, email: 'payer@example.com' }, process.env.JWT_SECRET);
    const server = await listen(createApp({ pool: injectedPool }));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const profileResponse = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(profileResponse.status, 200);
      assert.deepEqual((await profileResponse.json()).user, {
        id: payerId,
        name: 'Payer',
        email: 'payer@example.com',
        balance_cents: 1000,
        formatted_balance: '$10.00',
        household: { id: householdId, name: 'Test home', invite_code: 'INVITE42' }
      });

      const paymentResponse = await fetch(`${baseUrl}/api/payments/pay-chore`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ chore_id: choreId })
      });
      assert.equal(paymentResponse.status, 200);
      assert.deepEqual(await paymentResponse.json(), {
        success: true,
        transaction: { id: 'transaction-1', amount_cents: 400 }
      });

      assert.equal(calls.filter(call => call.kind === 'pool.query' && call.sql.includes('FROM users u')).length, 1);
      assert.equal(calls.filter(call => call.kind === 'pool.query' && call.sql.includes('SELECT session_version')).length, 2);
      assert.equal(calls.filter(call => call.kind === 'pool.connect').length, 1);
      assert.equal(releaseCount, 1);
      assert.ok(calls.some(call => call.kind === 'client.query' && call.sql === 'COMMIT'));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('health response includes a valid timestamp and omits the Express fingerprint header', async () => {
  const server = await listen(createApp({ pool: {} }));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.timestamp, 'string');
    assert.equal(Number.isNaN(Date.parse(body.timestamp)), false);
    assert.equal(response.headers.get('x-powered-by'), null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('default CORS origin allows credentialed requests and preflight', async () => {
  await withClientOrigin(undefined, async () => {
    const server = await listen(createApp({ pool: {} }));

    try {
      const origin = 'http://localhost:5173';
      const response = await fetch(`http://127.0.0.1:${server.address().port}/health`, {
        headers: { Origin: origin }
      });
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true');

      const preflight = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization'
        }
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
      assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('configured CORS origin is used for preflight and does not authorize another origin', async () => {
  await withClientOrigin('https://client.example', async () => {
    const server = await listen(createApp({ pool: {} }));

    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const preflight = await fetch(`${baseUrl}/api/payments/pay-chore`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://client.example',
          'Access-Control-Request-Method': 'POST'
        }
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://client.example');
      assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');

      const disallowed = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'https://attacker.example' }
      });
      assert.equal(disallowed.status, 200);
      assert.equal(disallowed.headers.get('access-control-allow-origin'), 'https://client.example');
      assert.notEqual(disallowed.headers.get('access-control-allow-origin'), 'https://attacker.example');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('JSON body parser accepts bodies below 16 KiB and rejects bodies at or above the limit safely', async () => {
  let connectCount = 0;
  const server = await listen(createApp({
    pool: {
      async connect() {
        connectCount += 1;
        throw new Error('unexpected database connection');
      }
    }
  }));

  try {
    const url = `http://127.0.0.1:${server.address().port}/json-limit-check`;
    const bodyWithByteLength = byteLength => JSON.stringify({
      value: 'x'.repeat(byteLength - Buffer.byteLength('{"value":""}'))
    });
    const belowLimitBody = bodyWithByteLength(16 * 1024 - 1);
    const belowLimitResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: belowLimitBody
    });
    assert.equal(Buffer.byteLength(belowLimitBody), 16 * 1024 - 1);
    assert.equal(belowLimitResponse.status, 404);

    const exactLimitBody = bodyWithByteLength(16 * 1024);
    const exactLimitResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: exactLimitBody
    });
    assert.equal(Buffer.byteLength(exactLimitBody), 16 * 1024);
    assert.equal(exactLimitResponse.status, 404);

    const oversizedBody = bodyWithByteLength(16 * 1024 + 1);
    const oversizedResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedBody
    });
    assert.equal(Buffer.byteLength(oversizedBody), 16 * 1024 + 1);
    assert.equal(oversizedResponse.status, 400);
    assert.deepEqual(await oversizedResponse.json(), { error: 'Invalid request body' });
    assert.equal(connectCount, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('protected malformed, multibyte, and compressed requests keep CORS headers and honor byte limits', async () => {
  await withClientOrigin('https://client.example', async () => {
    let dependencyCalls = 0;
    const server = await listen(createApp({
      pool: {
        async query() {
          dependencyCalls += 1;
        },
        async connect() {
          dependencyCalls += 1;
        }
      }
    }));
    const url = `http://127.0.0.1:${server.address().port}/api/payments/pay-chore`;
    const multibyteBody = JSON.stringify({ value: '💡'.repeat(4100) });
    const oversizedJson = JSON.stringify({ value: 'x'.repeat(20 * 1024) });
    const compressedJson = gzipSync(Buffer.from(oversizedJson));
    const requests = [
      { name: 'malformed JSON', headers: { 'Content-Type': 'application/json' }, body: '{' },
      { name: 'multibyte JSON', headers: { 'Content-Type': 'application/json' }, body: multibyteBody },
      {
        name: 'gzip JSON',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: compressedJson
      }
    ];

    try {
      assert.ok(multibyteBody.length < 16 * 1024);
      assert.ok(Buffer.byteLength(multibyteBody) > 16 * 1024);
      assert.ok(Buffer.byteLength(oversizedJson) > 16 * 1024);
      assert.ok(compressedJson.length < 16 * 1024);

      for (const request of requests) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Origin: 'https://client.example', ...request.headers },
          body: request.body
        });

        assert.equal(response.status, 400, request.name);
        assert.deepEqual(await response.json(), { error: 'Invalid request body' }, request.name);
        assert.equal(response.headers.get('access-control-allow-origin'), 'https://client.example', request.name);
      }

      assert.equal(dependencyCalls, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('separate app instances retain their own CORS, pool, and AI client dependencies', async () => {
  await withJwtSecret('server-instance-test-secret', async () => {
    await withGeminiApiKey('server-instance-test-api-key', async () => {
      const firstUserId = '55555555-5555-4555-8555-555555555555';
      const secondUserId = '66666666-6666-4666-8666-666666666666';
      const firstPoolCalls = [];
      const secondPoolCalls = [];
      const firstAiCalls = [];
      const secondAiCalls = [];
      const createProfilePool = (userId, name, calls) => ({
        async query(sql) {
          calls.push(sql);
          if (sql.includes('SELECT session_version')) {
            return { rows: [{ session_version: 0 }] };
          }
          return {
            rows: [{
              id: userId,
              name,
              email: `${name.toLowerCase()}@example.test`,
              balance_cents: 500,
              household_id: null,
              household_name: null,
              household_invite_code: null
            }]
          };
        }
      });
      const createAiFactory = (calls, price) => ({ apiKey }) => {
        calls.push(apiKey);
        return {
          models: {
            async generateContent() {
              return {
                text: JSON.stringify({
                  suggested_price_usd: price,
                  difficulty_level: 'Easy',
                  reasoning: `Estimate ${price}`
                })
              };
            }
          }
        };
      };
      const firstApp = await withClientOrigin('https://first.example', () => createApp({
        pool: createProfilePool(firstUserId, 'First', firstPoolCalls),
        aiClientFactory: createAiFactory(firstAiCalls, 12.34)
      }));
      const secondApp = await withClientOrigin('https://second.example', () => createApp({
        pool: createProfilePool(secondUserId, 'Second', secondPoolCalls),
        aiClientFactory: createAiFactory(secondAiCalls, 56.78)
      }));
      const servers = [];

      try {
        servers.push(await listen(firstApp));
        servers.push(await listen(secondApp));
        const token = jwt.sign({ id: '77777777-7777-4777-8777-777777777777' }, process.env.JWT_SECRET);
        const instances = [
          {
            server: servers[0],
            origin: 'https://first.example',
            userId: firstUserId,
            name: 'First',
            expectedPrice: 1234,
            expectedReasoning: 'Estimate 12.34'
          },
          {
            server: servers[1],
            origin: 'https://second.example',
            userId: secondUserId,
            name: 'Second',
            expectedPrice: 5678,
            expectedReasoning: 'Estimate 56.78'
          }
        ];

        for (const instance of instances) {
          const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
          const profileResponse = await fetch(`${baseUrl}/api/auth/me`, {
            headers: { Authorization: `Bearer ${token}`, Origin: instance.origin }
          });
          const profile = await profileResponse.json();
          assert.equal(profileResponse.status, 200);
          assert.equal(profileResponse.headers.get('access-control-allow-origin'), instance.origin);
          assert.equal(profile.user.id, instance.userId);
          assert.equal(profile.user.name, instance.name);

          const estimateResponse = await fetch(`${baseUrl}/api/ai/estimate-price`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Origin: instance.origin,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              title: 'Clean kitchen',
              description: 'Wipe surfaces',
              geminiConsent: true
            })
          });
          assert.equal(estimateResponse.status, 200);
          assert.equal(estimateResponse.headers.get('access-control-allow-origin'), instance.origin);
          assert.deepEqual(await estimateResponse.json(), {
            price_cents: instance.expectedPrice,
            difficulty: 'Easy',
            reasoning: instance.expectedReasoning
          });
        }

        assert.equal(firstPoolCalls.length, 3);
        assert.equal(secondPoolCalls.length, 3);
        assert.deepEqual(firstAiCalls, ['server-instance-test-api-key']);
        assert.deepEqual(secondAiCalls, ['server-instance-test-api-key']);
      } finally {
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
      }
    });
  });
});

test('unsupported methods and unknown paths do not invoke mounted route dependencies', async () => {
  await withJwtSecret('server-method-test-secret', async () => {
    let dependencyCalls = 0;
    const server = await listen(createApp({
      pool: {
        async query() {
          dependencyCalls += 1;
        },
        async connect() {
          dependencyCalls += 1;
        }
      },
      aiClientFactory() {
        dependencyCalls += 1;
        throw new Error('AI dependency should not run');
      }
    }));

    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const requests = [
        { method: 'GET', path: '/api/payments/pay-chore' },
        { method: 'GET', path: '/api/ai/estimate-price' },
        { method: 'POST', path: '/api/auth/me' },
        { method: 'POST', path: '/api/not-mounted' }
      ];

      for (const request of requests) {
        const response = await fetch(`${baseUrl}${request.path}`, { method: request.method });
        assert.equal(response.status, 404, `${request.method} ${request.path}`);
      }

      assert.equal(dependencyCalls, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('JSON parser rejects strict primitives and unsupported encodings while non-JSON bodies reach routes unparsed', async () => {
  await withJwtSecret('server-parser-test-secret', async () => {
    let dependencyCalls = 0;
    const token = jwt.sign({ id: '88888888-8888-4888-8888-888888888888' }, process.env.JWT_SECRET);
    const server = await listen(createApp({
      pool: {
        async query() {
          return { rows: [{ session_version: 0 }] };
        },
        async connect() {
          dependencyCalls += 1;
          throw new Error('Payment dependency should not run');
        }
      },
      aiClientFactory() {
        dependencyCalls += 1;
        throw new Error('AI dependency should not run');
      }
    }));

    try {
      const url = `http://127.0.0.1:${server.address().port}/api/ai/estimate-price`;
      const parserFailures = [
        { name: 'strict JSON primitive', headers: { 'Content-Type': 'application/json' }, body: 'true' },
        {
          name: 'unsupported charset',
          headers: { 'Content-Type': 'application/json; charset=unsupported-charset' },
          body: '{"title":"Clean kitchen"}'
        },
        {
          name: 'unsupported content encoding',
          headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
          body: '{"title":"Clean kitchen"}'
        }
      ];

      for (const request of parserFailures) {
        const response = await fetch(url, {
          method: 'POST',
          headers: request.headers,
          body: request.body
        });
        assert.equal(response.status, 400, request.name);
        assert.deepEqual(await response.json(), { error: 'Invalid request body' }, request.name);
      }

      const nonJsonEstimateResponse = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: '{"title":"Clean kitchen"}'
      });
      assert.equal(nonJsonEstimateResponse.status, 400);
      assert.deepEqual(await nonJsonEstimateResponse.json(), {
        error: 'A valid chore title and description are required'
      });

      const nonJsonPaymentResponse = await fetch(`${url.replace('/api/ai/estimate-price', '/api/payments/pay-chore')}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: '{"chore_id":"44444444-4444-4444-8444-444444444444"}'
      });
      assert.equal(nonJsonPaymentResponse.status, 400);
      assert.deepEqual(await nonJsonPaymentResponse.json(), { error: 'A valid chore ID is required' });
      assert.equal(dependencyCalls, 0);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

test('forwards errors when the response headers have already been sent', () => {
  const app = createApp({ pool: {} });
  const errorHandler = app._router.stack.find(layer => layer.handle.length === 4)?.handle;
  const error = new Error('response already started');
  let forwardedError;

  assert.equal(typeof errorHandler, 'function');
  errorHandler(error, {}, { headersSent: true }, nextError => {
    forwardedError = nextError;
  });

  assert.equal(forwardedError, error);
});

test('direct server startup serves the health endpoint', async () => {
  const port = await getAvailablePort();
  const child = spawnServer(port);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  try {
    const output = await waitForStartup(child);
    assert.match(output, new RegExp(`Payment API listening on port ${port}`));
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(Number.isNaN(Date.parse(body.timestamp)), false);
  } catch (error) {
    error.message += stderr ? `\nServer stderr: ${stderr}` : '';
    throw error;
  } finally {
    await stopChild(child);
  }
});

test('server startup falls back to port 3000 when PORT is unset or invalid', async t => {
  for (const [name, port] of [['unset PORT', undefined], ['invalid PORT', 'not-a-port']]) {
    await t.test(name, async () => {
      const child = spawnServer(port, { stubListen: true });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });

      try {
        const output = await waitForStartup(child);
        assert.match(output, /Captured listen port: 3000/);
        assert.match(output, /Payment API listening on port 3000/);
      } catch (error) {
        error.message += stderr ? `\nServer stderr: ${stderr}` : '';
        throw error;
      } finally {
        await stopChild(child);
      }
    });
  }
});