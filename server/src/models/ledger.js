const db = require('../config/database');

const LedgerController = {
  // Get all ledger transactions for current user
  async index(req, res) {
    try {
      const userId = req.user.id;

      const transactions = await db('ledger_transactions')
        .select(
          'ledger_transactions.*',
          db.raw("JSON_BUILD_OBJECT('id', from_users.id, 'name', from_users.name) as from_user_obj"),
          db.raw("JSON_BUILD_OBJECT('id', to_users.id, 'name', to_users.name) as to_user_obj"),
          'chores.title as chore_title'
        )
        .leftJoin('users as from_users', 'ledger_transactions.from_user', 'from_users.id')
        .leftJoin('users as to_users', 'ledger_transactions.to_user', 'to_users.id')
        .leftJoin('chores', 'ledger_transactions.chore_id', 'chores.id')
        .where('ledger_transactions.from_user', userId)
        .orWhere('ledger_transactions.to_user', userId)
        .orderBy('ledger_transactions.created_at', 'desc');

      res.json({ transactions });
    } catch (err) {
      console.error('Get ledger error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Get IOU summary for current user
  async summary(req, res) {
    try {
      const userId = req.user.id;

      // Calculate how much others owe the current user
      const owedToUser = await db('ledger_transactions')
        .select(db.raw('COALESCE(SUM(amount_cents), 0) as total_cents'))
        .where('to_user', userId)
        .where('status', 'pending');

      // Calculate how much the current user owes others
      const owedByUser = await db('ledger_transactions')
        .select(db.raw('COALESCE(SUM(amount_cents), 0) as total_cents'))
        .where('from_user', userId)
        .where('status', 'pending');

      // Get breakdown by user
      const owesMe = await db('ledger_transactions')
        .select(
          'from_user',
          db.raw("JSON_BUILD_OBJECT('id', from_users.id, 'name', from_users.name) as user_obj"),
          db.raw('COUNT(*) as transaction_count'),
          db.raw('SUM(amount_cents) as total_cents')
        )
        .join('users as from_users', 'ledger_transactions.from_user', 'from_users.id')
        .where('to_user', userId)
        .where('status', 'pending')
        .groupBy('from_user', 'from_users.id', 'from_users.name');

      const iOwe = await db('ledger_transactions')
        .select(
          'to_user',
          db.raw("JSON_BUILD_OBJECT('id', to_users.id, 'name', to_users.name) as user_obj"),
          db.raw('COUNT(*) as transaction_count'),
          db.raw('SUM(amount_cents) as total_cents')
        )
        .join('users as to_users', 'ledger_transactions.to_user', 'to_users.id')
        .where('from_user', userId)
        .where('status', 'pending')
        .groupBy('to_user', 'to_users.id', 'to_users.name');

      res.json({
        summary: {
          owedToMe: parseInt(owedToUser[0].total_cents),
          iOweOthers: parseInt(owedByUser[0].total_cents),
          netBalance: parseInt(owedToUser[0].total_cents) - parseInt(owedByUser[0].total_cents),
          owesMe,
          iOwe
        }
      });
    } catch (err) {
      console.error('Get summary error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Mark a transaction as paid
  async markPaid(req, res) {
    try {
      const { id } = req.params;
      const transaction = await db('ledger_transactions').where({ id }).first();

      if (!transaction) {
        return res.status(404).json({ error: 'Transaction not found.' });
      }

      await db('ledger_transactions')
        .where({ id })
        .update({ status: 'completed' });

      res.json({ message: 'Transaction marked as paid.' });
    } catch (err) {
      console.error('Mark paid error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Create a manual IOU entry
  async createIOU(req, res) {
    try {
      const { to_user, amount_cents, description } = req.body;

      if (!to_user || !amount_cents || amount_cents <= 0) {
        return res.status(400).json({ error: 'Valid to_user and amount_cents are required.' });
      }

      if (to_user === req.user.id) {
        return res.status(400).json({ error: 'Cannot create IOU with yourself.' });
      }

      const [transaction] = await db('ledger_transactions').insert({
        from_user: req.user.id,
        to_user,
        amount_cents,
        type: 'manual_iou',
        description: description || 'Manual IOU entry',
        status: 'pending'
      }).returning('*');

      res.status(201).json({ transaction });
    } catch (err) {
      console.error('Create IOU error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
};

module.exports = LedgerController;
