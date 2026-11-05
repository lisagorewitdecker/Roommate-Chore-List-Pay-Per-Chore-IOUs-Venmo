const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { createApp } = require('../server.cjs');
const { createGeminiClient } = require('../controllers/aiPricingController.cjs');

const secret = 'ai-suggestions-test-secret';
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

async function requestSuggestions({
  householdId = 'household-a',
  titles = ['Wash shared dishes', 'Take out household recycling'],
  assignments = [
    { chore_count: 2 },
    { chore_count: 1 }
  ],
  modelText = '{"suggestions":[{"title":"Clean shared counters","description":"Wipe kitchen and bathroom counters.","suggested_cost_cents":500,"frequency":"Weekly","reason":"Keeps shared surfaces hygienic."}]}',
  providerError,
  fetchImpl,
  apiKey = 'test-gemini-key',
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
      if (databaseError) throw databaseError;
      if (sql.includes('SELECT household_id FROM users')) {
        return { rows: [{ household_id: householdId }] };
      }
      if (sql.includes('SELECT title FROM chores')) {
        return { rows: titles.map(title => ({ title })) };
      }
      return { rows: assignments };
    }
  };
  const modelRequests = [];
  const aiClientFactory = fetchImpl
    ? ({ apiKey: configuredApiKey }) => createGeminiClient({ apiKey: configuredApiKey, fetchImpl })
    : () => ({
      models: {
        async generateContent(request) {
          modelRequests.push(request);
          if (providerError) throw providerError;
          return { text: modelText };
        }
      }
    });
  const app = createApp({ pool, aiClientFactory });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const token = jwt.sign({ id: 'test-user', household_id: 'stale-household' }, secret);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/suggest-chores`, {
      method: 'POST',
      headers: {
        ...(authorization ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    return { response, body: await response.json(), queries, modelRequests };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('suggests chores from current household titles and anonymized workloads', async () => {
  const { response, body, queries, modelRequests } = await requestSuggestions();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    suggestions: [{
      title: 'Clean shared counters',
      description: 'Wipe kitchen and bathroom counters.',
      suggested_cost_cents: 500,
      frequency: 'Weekly',
      reason: 'Keeps shared surfaces hygienic.'
    }]
  });
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[0].values, ['test-user']);
  assert.deepEqual(queries[1].values, ['household-a', 20]);
  assert.deepEqual(queries[2].values, ['household-a']);
  const prompt = modelRequests[0].contents[0].parts[0].text;
  assert.match(prompt, /Wash shared dishes/);
  assert.match(prompt, /Take out household recycling/);
  assert.match(prompt, /Roommate 1: 2 chores/);
  assert.match(prompt, /Roommate 2: 1 chores/);
  assert.doesNotMatch(prompt, /test-user|stale-household|private-user@example\.test/i);
  assert.doesNotMatch(queries[1].sql, /description|email|name/i);
  assert.deepEqual(modelRequests[0].model, 'gemini-test-model');
});

test('allows households with no existing chores or assignments', async () => {
  const { response, body, modelRequests } = await requestSuggestions({
    titles: [],
    assignments: [{ chore_count: 0 }]
  });

  assert.equal(response.status, 200);
  assert.equal(body.suggestions.length, 1);
  assert.match(modelRequests[0].contents[0].parts[0].text, /No existing chores are recorded/);
});

test('sends and parses synthetic suggestions through the Gemini REST adapter', async () => {
  let outgoingRequest;
  const { response, body } = await requestSuggestions({
    fetchImpl: async (url, options) => {
      outgoingRequest = { url, options };
      return {
        ok: true,
        async json() {
          return {
            candidates: [{
              content: {
                parts: [{ text: '{"suggestions":[{"title":"Sweep entryway","description":"Sweep shared entrance floors.","suggested_cost_cents":300,"frequency":"Weekly","reason":"Keeps the shared entrance tidy."}]}' }]
              }
            }]
          };
        }
      };
    }
  });

  assert.equal(response.status, 200);
  assert.equal(body.suggestions[0].title, 'Sweep entryway');
  assert.match(outgoingRequest.url, /models\/gemini-test-model:generateContent$/);
  assert.equal(outgoingRequest.options.headers['x-goog-api-key'], 'test-gemini-key');
  const requestBody = JSON.parse(outgoingRequest.options.body);
  assert.match(requestBody.contents[0].parts[0].text, /Wash shared dishes/);
  assert.equal(requestBody.generationConfig.responseSchema.properties.suggestions.items.properties.suggested_cost_cents.type, 'INTEGER');
});

test('requires authentication before reading household data', async () => {
  const { response, body, queries, modelRequests } = await requestSuggestions({ authorization: false });

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: 'Missing or malformed token' });
  assert.equal(queries.length, 0);
  assert.equal(modelRequests.length, 0);
});

test('uses current database membership and rejects accounts without a household', async () => {
  const { response, body, queries, modelRequests } = await requestSuggestions({ householdId: null });

  assert.equal(response.status, 403);
  assert.deepEqual(body, { error: 'Your account is not part of a household' });
  assert.equal(queries.length, 1);
  assert.equal(modelRequests.length, 0);
});

test('reports missing Gemini configuration without calling the provider', async () => {
  const { response, body, modelRequests } = await requestSuggestions({ apiKey: '' });

  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    error: 'AI chore suggestions are unavailable. Configure GEMINI_API_KEY on the API server and restart it.'
  });
  assert.equal(modelRequests.length, 0);
});

test('rejects malformed, oversized, or invalid model output', async () => {
  const invalidOutputs = [
    'not json',
    '{"suggestions":[]}',
    '{"suggestions":[{"title":" ","description":"Clean","suggested_cost_cents":0,"frequency":"Weekly","reason":"Routine task."}]}',
    '{"suggestions":[{"title":"Clean","description":"Clean","suggested_cost_cents":2147483648,"frequency":"Weekly","reason":"Routine task."}]}',
    JSON.stringify({ suggestions: Array.from({ length: 6 }, (_, index) => ({
      title: `Chore ${index}`,
      description: 'Do the task.',
      suggested_cost_cents: 0,
      frequency: 'Weekly',
      reason: 'Routine task.'
    })) })
  ];

  for (const modelText of invalidOutputs) {
    const { response, body } = await requestSuggestions({ modelText });
    assert.equal(response.status, 502);
    assert.deepEqual(body, { error: 'Unable to generate chore suggestions' });
  }
});

test('does not expose provider or database errors', async () => {
  const providerResult = await requestSuggestions({ providerError: new Error('private upstream details') });
  assert.equal(providerResult.response.status, 502);
  assert.deepEqual(providerResult.body, {
    error: 'AI chore suggestions failed. Check GEMINI_API_KEY, GEMINI_MODEL, and API quota on the server.'
  });

  const databaseResult = await requestSuggestions({ databaseError: new Error('private database details') });
  assert.equal(databaseResult.response.status, 500);
  assert.deepEqual(databaseResult.body, { error: 'Unable to generate chore suggestions' });
});