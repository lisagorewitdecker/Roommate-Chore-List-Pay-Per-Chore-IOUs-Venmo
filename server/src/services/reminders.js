const db = require('../config/database');

const ReminderController = {
  // Get all reminders for current user
  async index(req, res) {
    try {
      const userId = req.user.id;

      const reminders = await db('payment_reminders')
        .select(
          'payment_reminders.*',
          'ledger_transactions.amount_cents',
          'ledger_transactions.description as transaction_description',
          db.raw("JSON_BUILD_OBJECT('id', from_users.id, 'name', from_users.name) as from_user_obj"),
          db.raw("JSON_BUILD_OBJECT('id', to_users.id, 'name', to_users.name) as to_user_obj")
        )
        .join('ledger_transactions', 'payment_reminders.transaction_id', 'ledger_transactions.id')
        .join('users as from_users', 'payment_reminders.from_user', 'from_users.id')
        .join('users as to_users', 'payment_reminders.to_user', 'to_users.id')
        .where('payment_reminders.from_user', userId)
        .orWhere('payment_reminders.to_user', userId)
        .orderBy('payment_reminders.scheduled_for', 'asc');

      res.json({ reminders });
    } catch (err) {
      console.error('Get reminders error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Create a payment reminder
  async store(req, res) {
    try {
      const { transaction_id, to_user, scheduled_for } = req.body;

      if (!transaction_id || !to_user) {
        return res.status(400).json({ error: 'transaction_id and to_user are required.' });
      }

      const transaction = await db('ledger_transactions')
        .where({ id: transaction_id, status: 'pending' })
        .where(function () {
          this.where('from_user', req.user.id).orWhere('to_user', req.user.id);
        })
        .first();

      if (!transaction) {
        return res.status(404).json({ error: 'Pending transaction not found.' });
      }

      const [reminder] = await db('payment_reminders').insert({
        transaction_id,
        from_user: transaction.from_user,
        to_user: transaction.to_user,
        status: 'scheduled',
        scheduled_for: scheduled_for || new Date(Date.now() + 24 * 60 * 60 * 1000)
      }).returning('*');

      res.status(201).json({ reminder });
    } catch (err) {
      console.error('Create reminder error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Send all due reminders (called by cron or manually)
  async sendDueReminders(req, res) {
    try {
      const now = new Date();

      // Find due reminders
      const dueReminders = await db('payment_reminders')
        .where('status', 'scheduled')
        .where('scheduled_for', '<=', now);

      // Mark them as sent
      const ids = dueReminders.map(r => r.id);
      if (ids.length > 0) {
        await db('payment_reminders')
          .where('id', 'in', ids)
          .update({
            status: 'sent',
            sent_at: now
          });
      }

      // In a real app, you would send emails/notifications here
      // For now, we just log and return the count
      res.json({
        message: `${ids.length} reminders processed.`,
        sent: ids.length
      });
    } catch (err) {
      console.error('Send reminders error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Get all users for reminder creation
  async getUsers(req, res) {
    try {
      const users = await db('users')
        .select('id', 'name', 'email')
        .where('id', '!=', req.user.id);

      res.json({ users });
    } catch (err) {
      console.error('Get users error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
};

module.exports = ReminderController;
