const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { createApp } = require('../server.cjs');

const secret = 'ai-fairness-test-secret';
const previousEnvironment = {
  JWT_SECRET: process.env.JWT_SECRET,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL
};

test.afterEach(() => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function requestFairness({
  householdId = 'household-a',
  aggregates = [
    { chore_count: 2, total_value_cents: 5000 },
    { chore_count: 1, total_value_cents: 2500 }
  ],
  modelText = '{"fairness_score":7,"observations":["Roommate 1 has more assigned chores."],"recommendations":["Rotate future assignments."]}',
  providerError,
  apiKey = 'test-gemini-key',
  geminiConsent = true,
  authorization = true,
  databaseError
} = {}) {
  process.env.JWT_SECRET = secret;
  process.env.GEMINI_MODEL = 'gemini-test-model';
  if (apiKey) process.env.GEMINI_API_KEY = apiKey;
  else delete process.env.GEMINI_API_KEY;

  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (databaseError && !sql.includes('SELECT session_version')) throw databaseError;
      if (sql.includes('SELECT session_version')) return { rows: [{ session_version: 0 }] };
      if (sql.includes('SELECT household_id FROM users')) {
        return { rows: [{ household_id: householdId }] };
      }
      return { rows: aggregates };
    }
  };
  const modelRequests = [];
  const app = createApp({
    pool,
    aiClientFactory: () => ({
      models: {
        async generateContent(request) {
          modelRequests.push(request);
          if (providerError) throw providerError;
          return { text: modelText };
        }
      }
    })
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const token = jwt.sign({ id: 'test-user', household_id: 'stale-household' }, secret);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/fair-split`, {
      method: 'POST',
      body: JSON.stringify({ geminiConsent }),
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    return { response, body: await response.json(), queries, modelRequests };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('analyzes anonymized household chore counts and values', async () => {
  const { response, body, queries, modelRequests } = await requestFairness();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    analysis: {
      fairness_score: 7,
      observations: ['Roommate 1 has more assigned chores.'],
      recommendations: ['Rotate future assignments.']
    }
  });
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[1].values, ['test-user']);
  assert.deepEqual(queries[2].values, ['household-a']);
  assert.match(queries[2].sql, /u\.household_id = \$1/);
  const prompt = modelRequests[0].contents[0].parts[0].text;
  assert.match(prompt, /Roommate 1: 2 assigned chores, total value 5000 cents/);
  assert.match(prompt, /Roommate 2: 1 assigned chores, total value 2500 cents/);
  assert.doesNotMatch(prompt, /test-user|stale-household|email|description/i);
});

test('requires authentication before reading household data', async () => {
  const { response, body, queries, modelRequests } = await requestFairness({ authorization: false });

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: 'Missing or malformed token' });
  assert.equal(queries.length, 0);
  assert.equal(modelRequests.length, 0);
});

test('requires explicit consent before reading household data or calling Gemini', async () => {
  const { response, body, queries, modelRequests } = await requestFairness({ geminiConsent: false });

  assert.equal(response.status, 400);
  assert.deepEqual(body, { error: 'Consent to share chore data with Gemini is required' });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /SELECT session_version/);
  assert.equal(modelRequests.length, 0);
});

test('uses current database membership and rejects accounts without a household', async () => {
  const { response, body, queries, modelRequests } = await requestFairness({ householdId: null });

  assert.equal(response.status, 403);
  assert.deepEqual(body, { error: 'Your account is not part of a household' });
  assert.equal(queries.length, 2);
  assert.equal(modelRequests.length, 0);
});

test('explains that assigned chores are needed without calling Gemini', async () => {
  const { response, body, modelRequests } = await requestFairness({
    aggregates: [{ chore_count: 0, total_value_cents: 0 }]
  });

  assert.equal(response.status, 422);
  assert.deepEqual(body, { error: 'Assign chores to household members before analyzing fairness.' });
  assert.equal(modelRequests.length, 0);
});

test('reports missing Gemini configuration without calling the provider', async () => {
  const { response, body, modelRequests } = await requestFairness({ apiKey: '' });

  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    error: 'AI fairness analysis is unavailable. Configure GEMINI_API_KEY on the API server and restart it.'
  });
  assert.equal(modelRequests.length, 0);
});

test('rejects malformed or out-of-range analysis output', async () => {
  for (const modelText of [
    'not json',
    '{"fairness_score":11,"observations":[],"recommendations":[]}',
    '{"fairness_score":5,"observations":"not an array","recommendations":[]}'
  ]) {
    const { response, body } = await requestFairness({ modelText });

    assert.equal(response.status, 502);
    assert.deepEqual(body, { error: 'Unable to analyze household fairness' });
  }
});

test('does not expose provider or database errors', async () => {
  const providerResult = await requestFairness({ providerError: new Error('private upstream details') });
  assert.equal(providerResult.response.status, 502);
  assert.deepEqual(providerResult.body, {
    error: 'AI fairness analysis failed. Check GEMINI_API_KEY, GEMINI_MODEL, and API quota on the server.'
  });

  const databaseResult = await requestFairness({ databaseError: new Error('private database details') });
  assert.equal(databaseResult.response.status, 500);
  assert.deepEqual(databaseResult.body, { error: 'Unable to analyze household fairness' });
});