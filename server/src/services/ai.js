const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../config/database');

let genAI = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

const AIController = {
  // Get AI-powered chore suggestions
  async suggestChores(req, res) {
    try {
      if (!genAI) {
        return res.status(503).json({ error: 'AI service not configured. Set GEMINI_API_KEY.' });
      }

      // Get current chores and users
      const chores = await db('chores').select('title', 'frequency', 'assigned_to', 'is_completed');
      const users = await db('users').select('id', 'name');

      const prompt = `
You are a helpful roommate chore management assistant. Based on the current state of chores and roommates, suggest 3-5 new chores that would be helpful for a shared living space.

Current roommates: ${users.map(u => u.name).join(', ')}
Current chores: ${chores.map(c => `${c.title} (${c.frequency}, ${c.is_completed ? 'completed' : 'pending'})`).join(', ')}

Return a JSON array of chore suggestions with this format:
[
  {
    "title": "Chore title",
    "description": "Brief description",
    "suggested_cost_cents": 500,
    "frequency": "weekly",
    "reason": "Why this chore is suggested"
  }
]

Focus on practical, fair chores that promote a clean and harmonious living environment.
`;

      const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      // Parse JSON from the response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const suggestions = JSON.parse(jsonMatch[0]);
        res.json({ suggestions });
      } else {
        res.json({ suggestions: [], raw: text });
      }
    } catch (err) {
      console.error('AI suggest error:', err);
      res.status(500).json({ error: 'Failed to generate AI suggestions.' });
    }
  },

  // Get AI-powered fair split analysis
  async fairSplit(req, res) {
    try {
      if (!genAI) {
        return res.status(503).json({ error: 'AI service not configured. Set GEMINI_API_KEY.' });
      }

      const userId = req.user.id;
      const users = await db('users').select('id', 'name');
      const chores = await db('chores')
        .select('title', 'cost_cents', 'assigned_to', 'is_completed', 'frequency')
        .leftJoin('users as assignee', 'chores.assigned_to', 'assignee.id')
        .pluck('chores')
        .map(row => row);

      const ledger = await db('ledger_transactions')
        .select(
          'ledger_transactions.from_user',
          'ledger_transactions.to_user',
          'ledger_transactions.amount_cents',
          'ledger_transactions.status',
          db.raw("from_u.name as from_name"),
          db.raw("to_u.name as to_name")
        )
        .join('users as from_u', 'ledger_transactions.from_user', 'from_u.id')
        .join('users as to_u', 'ledger_transactions.to_user', 'to_u.id')
        .where('ledger_transactions.status', 'pending');

      const prompt = `
You are a fair chore and payment analysis assistant for roommates.

Roommates: ${users.map(u => u.name).join(', ')}

Current chore assignments:
${chores.map(c => `- ${c.title}: $${(c.cost_cents / 100).toFixed(2)}, ${c.frequency}, ${c.is_completed ? 'completed' : 'pending'}`).join('\n')}

Pending IOUs:
${ledger.map(t => `- ${t.from_name} owes ${t.to_name}: $${(t.amount_cents / 100).toFixed(2)}`).join('\n')}

Analyze whether the current chore distribution and payments are fair. Provide:
1. A fairness score (1-10)
2. Key observations about imbalances
3. Specific recommendations to improve fairness

Return as JSON:
{
  "fairness_score": 7,
  "observations": ["Observation 1", "Observation 2"],
  "recommendations": ["Recommendation 1", "Recommendation 2"]
}
`;

      const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const analysis = JSON.parse(jsonMatch[0]);
        res.json({ analysis });
      } else {
        res.json({ analysis: null, raw: text });
      }
    } catch (err) {
      console.error('AI fair split error:', err);
      res.status(500).json({ error: 'Failed to generate fair split analysis.' });
    }
  }
};

module.exports = AIController;
