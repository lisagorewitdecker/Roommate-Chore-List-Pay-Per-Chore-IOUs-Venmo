import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../server.cjs';
import { createGeminiClient } from '../controllers/aiPricingController.cjs';

const secret = 'ai-pricing-test-secret';
const previousJwtSecret = process.env.JWT_SECRET;
const previousGeminiKey = process.env.GEMINI_API_KEY;
const previousGeminiModel = process.env.GEMINI_MODEL;

afterEach(() => {
  if (previousJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousJwtSecret;
  }
  if (previousGeminiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = previousGeminiKey;
  }
  if (previousGeminiModel === undefined) {
    delete process.env.GEMINI_MODEL;
  } else {
    process.env.GEMINI_MODEL = previousGeminiModel;
  }
});

async function requestEstimate({
  body = { title: 'Clean the kitchen', description: 'Wipe counters and mop the floor' },
  modelText = '{"suggested_price_usd": 12.345, "difficulty_level": "Medium", "reasoning": "The task includes several routine cleaning steps."}',
  providerError,
  apiKey = 'test-gemini-key',
  model,
  geminiConsent = true,
  authorization = true
} = {}) {
  process.env.JWT_SECRET = secret;
  if (!apiKey) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = apiKey;
  }
  if (model) process.env.GEMINI_MODEL = model;
  else delete process.env.GEMINI_MODEL;

  let generateContentCalls = 0;
  const requestedModels = [];
  const app = createApp({
    aiClientFactory: () => ({
      models: {
        async generateContent(request) {
          generateContentCalls += 1;
          requestedModels.push(request.model);
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
    const token = jwt.sign({ id: 'user-id' }, secret);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/estimate-price`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ ...body, geminiConsent })
    });
    return { response, body: await response.json(), generateContentCalls, requestedModels };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('estimates chore pricing in cents and returns difficulty and reasoning', async () => {
  const { response, body, generateContentCalls, requestedModels } = await requestEstimate();

  assert.equal(response.status, 200);
  assert.deepEqual(requestedModels, ['gemini-3.8-flash']);
  assert.deepEqual(body, {
    price_cents: 1235,
    difficulty: 'Medium',
    reasoning: 'The task includes several routine cleaning steps.'
  });
  assert.equal(generateContentCalls, 1);
});

test('uses the configured Gemini model override', async () => {
  const { response, requestedModels } = await requestEstimate({ model: 'gemini-test-model' });

  assert.equal(response.status, 200);
  assert.deepEqual(requestedModels, ['gemini-test-model']);
});

test('requires a title and validates chore details before calling Gemini', async () => {
  for (const body of [
    {},
    { title: '  ', description: 'Some detail' },
    { title: 'Valid title', description: { unexpected: true } }
  ]) {
    const result = await requestEstimate({ body });

    assert.equal(result.response.status, 400);
    assert.equal(result.generateContentCalls, 0);
  }
});

test('requires explicit consent before sending chore details to Gemini', async () => {
  const { response, body, generateContentCalls } = await requestEstimate({ geminiConsent: false });

  assert.equal(response.status, 400);
  assert.deepEqual(body, { error: 'Consent to share chore data with Gemini is required' });
  assert.equal(generateContentCalls, 0);
});

test('reports missing Gemini configuration without calling the provider', async () => {
  const { response, body, generateContentCalls } = await requestEstimate({ apiKey: '' });

  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    error: 'AI pricing is unavailable. Configure GEMINI_API_KEY on the API server and restart it.'
  });
  assert.equal(generateContentCalls, 0);
});

test('rejects malformed or out-of-range model output', async () => {
  for (const modelText of [
    'not json',
    '{"suggested_price_usd": 100, "difficulty_level": "Hard", "reasoning": "Too expensive."}',
    '{"suggested_price_usd": 10, "difficulty_level": "Extreme", "reasoning": "Unknown category."}',
    '{"suggested_price_usd": 0, "difficulty_level": "Easy", "reasoning": "Free."}',
    '{"suggested_price_usd": 10, "difficulty_level": "Easy", "reasoning": "  "}'
  ]) {
    const { response, body } = await requestEstimate({ modelText });

    assert.equal(response.status, 502);
    assert.deepEqual(body, { error: 'Unable to estimate chore price' });
  }
});

test('does not expose provider errors to callers', async () => {
  const { response, body } = await requestEstimate({ providerError: new Error('private upstream details') });

  assert.equal(response.status, 502);
  assert.deepEqual(body, {
    error: 'AI price estimation failed. Check GEMINI_API_KEY, GEMINI_MODEL, and API quota on the server.'
  });
});

test('requires authentication before making an AI request', async () => {
  const { response, body, generateContentCalls } = await requestEstimate({ authorization: false });

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: 'Missing or malformed token' });
  assert.equal(generateContentCalls, 0);
});

test('sends a structured request through the Gemini REST adapter', async () => {
  const modelText = '{"suggested_price_usd": 12.34, "difficulty_level": "Medium", "reasoning": "Several routine steps."}';
  let capturedUrl;
  let capturedOptions;
  const client = createGeminiClient({
    apiKey: 'test-gemini-key',
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        async json() {
          return { candidates: [{ content: { parts: [{ text: modelText }] } }] };
        }
      };
    }
  });
  const request = {
    model: 'gemini-3.8-flash',
    contents: [{ role: 'user', parts: [{ text: 'Estimate this chore.' }] }],
    generationConfig: { responseMimeType: 'application/json' }
  };

  const result = await client.models.generateContent(request);

  assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['x-goog-api-key'], 'test-gemini-key');
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    contents: request.contents,
    generationConfig: request.generationConfig
  });
  assert.deepEqual(result, { text: modelText });
});