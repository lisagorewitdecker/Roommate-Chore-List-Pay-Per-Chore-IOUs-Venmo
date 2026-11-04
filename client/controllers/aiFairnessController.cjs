const { createGeminiClient } = require('./aiPricingController.cjs');

const GEMINI_MODEL = 'gemini-3.8-flash';
const MAX_LIST_ITEMS = 8;
const MAX_TEXT_LENGTH = 500;

function parseTextList(value) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null;
  const items = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (items.some(item => !item || item.length > MAX_TEXT_LENGTH)) return null;
  return items;
}

function createAiFairnessController(pool, aiClientFactory = createGeminiClient) {
  return async (req, res) => {
    try {
      const membership = await pool.query(
        'SELECT household_id FROM users WHERE id = $1',
        [req.user.id]
      );
      const householdId = membership.rows[0]?.household_id;
      if (!householdId) {
        return res.status(403).json({ error: 'Your account is not part of a household' });
      }

      const result = await pool.query(
        `SELECT COUNT(c.id) AS chore_count,
                COALESCE(SUM(c.price_cents), 0) AS total_value_cents
         FROM users u
         LEFT JOIN chores c ON c.assigned_to = u.id AND c.household_id = u.household_id
         WHERE u.household_id = $1
         GROUP BY u.id
         ORDER BY u.id`,
        [householdId]
      );
      const assignments = result.rows.map((row, index) => ({
        label: `Roommate ${index + 1}`,
        choreCount: Number(row.chore_count),
        totalValueCents: Number(row.total_value_cents)
      }));

      if (assignments.some(({ choreCount, totalValueCents }) =>
        !Number.isSafeInteger(choreCount) || choreCount < 0 ||
        !Number.isSafeInteger(totalValueCents) || totalValueCents < 0)) {
        return res.status(500).json({ error: 'Unable to analyze household fairness' });
      }
      if (!assignments.some(({ choreCount }) => choreCount > 0)) {
        return res.status(422).json({ error: 'Assign chores to household members before analyzing fairness.' });
      }

      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey) {
        return res.status(503).json({
          error: 'AI fairness analysis is unavailable. Configure GEMINI_API_KEY on the API server and restart it.'
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
              text: `Assess the recorded chore assignment workload for this household. This is only a limited snapshot, not a definitive judgment: prices may not reflect effort, and schedules or unrecorded work are not included. Return a fairness score from 0 to 10, concise observations, and practical recommendations. Use only these anonymized aggregate counts and values; do not infer personal details.\n${assignments
                .map(({ label, choreCount, totalValueCents }) =>
                  `${label}: ${choreCount} assigned chores, total value ${totalValueCents} cents`)
                .join('\n')}`
            }]
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                fairness_score: { type: 'NUMBER' },
                observations: { type: 'ARRAY', items: { type: 'STRING' } },
                recommendations: { type: 'ARRAY', items: { type: 'STRING' } }
              },
              required: ['fairness_score', 'observations', 'recommendations']
            }
          }
        });
      } catch {
        return res.status(502).json({
          error: 'AI fairness analysis failed. Check GEMINI_API_KEY, GEMINI_MODEL, and API quota on the server.'
        });
      }

      let analysis;
      try {
        analysis = JSON.parse(response?.text || '');
      } catch {
        return res.status(502).json({ error: 'Unable to analyze household fairness' });
      }
      const observations = parseTextList(analysis?.observations);
      const recommendations = parseTextList(analysis?.recommendations);
      if (typeof analysis?.fairness_score !== 'number' ||
          !Number.isFinite(analysis.fairness_score) ||
          analysis.fairness_score < 0 || analysis.fairness_score > 10 ||
          !observations || !recommendations) {
        return res.status(502).json({ error: 'Unable to analyze household fairness' });
      }

      return res.status(200).json({
        analysis: {
          fairness_score: analysis.fairness_score,
          observations,
          recommendations
        }
      });
    } catch {
      return res.status(500).json({ error: 'Unable to analyze household fairness' });
    }
  };
}

exports.createAiFairnessController = createAiFairnessController;