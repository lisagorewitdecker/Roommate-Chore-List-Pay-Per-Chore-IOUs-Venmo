const db = require('../config/database');

const ChoreController = {
  // Get all chores
  async index(req, res) {
    try {
      const chores = await db('chores')
        .select(
          'chores.*',
          db.raw("JSON_BUILD_OBJECT('id', assigned_to_users.id, 'name', assigned_to_users.name) as assigned_to"),
          db.raw("JSON_BUILD_OBJECT('id', created_by_users.id, 'name', created_by_users.name) as created_by")
        )
        .leftJoin('users as assigned_to_users', 'chores.assigned_to', 'assigned_to_users.id')
        .leftJoin('users as created_by_users', 'chores.created_by', 'created_by_users.id')
        .orderBy('chores.created_at', 'desc');

      res.json({ chores });
    } catch (err) {
      console.error('Get chores error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Get a single chore
  async show(req, res) {
    try {
      const chore = await db('chores')
        .select(
          'chores.*',
          db.raw("JSON_BUILD_OBJECT('id', assigned_to_users.id, 'name', assigned_to_users.name) as assigned_to"),
          db.raw("JSON_BUILD_OBJECT('id', created_by_users.id, 'name', created_by_users.name) as created_by")
        )
        .leftJoin('users as assigned_to_users', 'chores.assigned_to', 'assigned_to_users.id')
        .leftJoin('users as created_by_users', 'chores.created_by', 'created_by_users.id')
        .where('chores.id', req.params.id)
        .first();

      if (!chore) {
        return res.status(404).json({ error: 'Chore not found.' });
      }

      res.json({ chore });
    } catch (err) {
      console.error('Get chore error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Create a new chore
  async store(req, res) {
    try {
      const { title, description, cost_cents, frequency, assigned_to, due_date } = req.body;

      if (!title) {
        return res.status(400).json({ error: 'Title is required.' });
      }

      const chore = {
        title,
        description,
        cost_cents: cost_cents || 0,
        frequency: frequency || 'once',
        assigned_to,
        created_by: req.user.id,
        due_date
      };

      const [newChore] = await db('chores').insert(chore).returning('*');
      res.status(201).json({ chore: newChore });
    } catch (err) {
      console.error('Create chore error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Update a chore
  async update(req, res) {
    try {
      const { title, description, cost_cents, frequency, assigned_to, due_date } = req.body;

      const updates = {
        title,
        description,
        cost_cents,
        frequency,
        assigned_to,
        due_date
      };

      await db('chores').where({ id: req.params.id }).update(updates);

      const chore = await db('chores').where({ id: req.params.id }).first();
      res.json({ chore });
    } catch (err) {
      console.error('Update chore error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Complete a chore and create ledger transaction
  async complete(req, res) {
    try {
      const chore = await db('chores').where({ id: req.params.id }).first();

      if (!chore) {
        return res.status(404).json({ error: 'Chore not found.' });
      }

      await db.transaction(async (trx) => {
        // Only the first completion creates a ledger transaction.
        const [chore] = await trx('chores')
          .where({ id: req.params.id, is_completed: false })
          .update({
            is_completed: true,
            completed_at: new Date()
          })
          .returning('*');

        if (!chore) return;

        // Create ledger transaction if chore has a cost and is assigned
        if (chore.cost_cents > 0 && chore.assigned_to && chore.created_by && chore.assigned_to !== chore.created_by) {
          await trx('ledger_transactions').insert({
            from_user: chore.assigned_to,
            to_user: chore.created_by,
            amount_cents: chore.cost_cents,
            chore_id: chore.id,
            type: 'chore_payment',
            description: `Payment for "${chore.title}"`,
            status: 'pending'
          });
        }
      });

      const updatedChore = await db('chores').where({ id: req.params.id }).first();
      res.json({ chore: updatedChore });
    } catch (err) {
      console.error('Complete chore error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Delete a chore
  async destroy(req, res) {
    try {
      const deleted = await db('chores').where({ id: req.params.id }).del();

      if (!deleted) {
        return res.status(404).json({ error: 'Chore not found.' });
      }

      res.json({ message: 'Chore deleted successfully.' });
    } catch (err) {
      console.error('Delete chore error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
};

module.exports = ChoreController;
