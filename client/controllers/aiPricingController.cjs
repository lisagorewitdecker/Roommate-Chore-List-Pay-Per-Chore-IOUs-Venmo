const GEMINI_MODEL = 'gemini-3.8-flash';
const MAX_PRICE_USD = 99.99;
const difficulties = ['Easy', 'Medium', 'Hard'];

function createGeminiClient({ apiKey, fetchImpl = globalThis.fetch } = {}) {
  return {
    models: {
      async generateContent({ model = GEMINI_MODEL, contents, generationConfig } = {}) {
        const response = await fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey
            },
            body: JSON.stringify({ contents, generationConfig })
          }
        );

        if (!response.ok) throw new Error('Gemini request failed');

        const result = await response.json();
        const text = result?.candidates?.[0]?.content?.parts
          ?.map(part => part.text || '')
          .join('');
        if (!text) throw new Error('Gemini returned no content');
        return { text };
      }
    }
  };
}

function createAiPricingController(aiClientFactory = createGeminiClient) {
  return async (req, res) => {
    const title = req.body?.title;
    const description = req.body?.description ?? '';

    if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
        typeof description !== 'string' || description.length > 2000) {
      return res.status(400).json({ error: 'A valid chore title and description are required' });
    }

    if (req.body?.geminiConsent !== true) {
      return res.status(400).json({ error: 'Consent to share chore data with Gemini is required' });
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return res.status(503).json({
        error: 'AI pricing is unavailable. Configure GEMINI_API_KEY on the API server and restart it.'
      });
    }

    let response;
    try {
      const client = aiClientFactory({ apiKey });
      response = await client.models.generateContent({
        model: process.env.GEMINI_MODEL || GEMINI_MODEL,
        contents: [{
          role: 'user',
          parts: [{
            text: `Estimate a fair chore price in USD. Return JSON with suggested_price_usd (number from 0.01 through ${MAX_PRICE_USD}), difficulty_level (Easy, Medium, or Hard), and concise reasoning (string). Chore title: ${title.trim()}. Description: ${description.trim()}`
          }]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              suggested_price_usd: { type: 'NUMBER' },
              difficulty_level: { type: 'STRING', enum: difficulties },
              reasoning: { type: 'STRING' }
            },
            required: ['suggested_price_usd', 'difficulty_level', 'reasoning']
          }
        }
      });
    } catch {
      return res.status(502).json({
        error: 'AI price estimation failed. Check GEMINI_API_KEY, GEMINI_MODEL, and API quota on the server.'
      });
    }

    let estimate;
    try {
      estimate = JSON.parse(response?.text || '');
    } catch {
      return res.status(502).json({ error: 'Unable to estimate chore price' });
    }
    const price = estimate.suggested_price_usd;
    const priceCents = Math.round(price * 100);

    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 ||
        price > MAX_PRICE_USD || !Number.isSafeInteger(priceCents) || priceCents < 1 ||
        !difficulties.includes(estimate.difficulty_level) ||
        typeof estimate.reasoning !== 'string' || !estimate.reasoning.trim()) {
      return res.status(502).json({ error: 'Unable to estimate chore price' });
    }

    return res.status(200).json({
      price_cents: priceCents,
      difficulty: estimate.difficulty_level,
      reasoning: estimate.reasoning.trim()
    });
  };
}

exports.createAiPricingController = createAiPricingController;
exports.createGeminiClient = createGeminiClient;