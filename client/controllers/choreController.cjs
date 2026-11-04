const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PRICE_CENTS = 2147483647;
const { createHouseholdExpenseIous } = require('./householdExpenses.cjs');

const choreSelection = `
  SELECT c.id, c.household_id, c.title, c.description, c.price_cents, c.created_by,
         c.status, c.settlement_type, c.ai_suggested, c.due_date, c.created_at, c.updated_at,
         CASE WHEN assignee.id IS NULL THEN NULL
           ELSE json_build_object('id', assignee.id, 'name', assignee.name)
         END AS assigned_to
  FROM chores c
  LEFT JOIN users assignee ON assignee.id = c.assigned_to
`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  if (value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validChoreId(value) {
  return UUID_PATTERN.test(value);
}

class ChoreActionError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function createChoreController(pool) {
  async function getHouseholdId(userId) {
    const result = await pool.query('SELECT household_id FROM users WHERE id = $1', [userId]);
    return result.rows[0]?.household_id || null;
  }

  async function list(req, res) {
    try {
      const householdId = await getHouseholdId(req.user.id);
      if (!householdId) return res.status(403).json({ error: 'Your account is not part of a household' });

      const result = await pool.query(
        `${choreSelection} WHERE c.household_id = $1 ORDER BY c.created_at DESC, c.id`,
        [householdId]
      );
      return res.status(200).json({ chores: result.rows });
    } catch {
      return res.status(500).json({ error: 'Unable to load chores' });
    }
  }

  async function create(req, res) {
    const body = req.body;
    if (!isObject(body) || typeof body.title !== 'string') {
      return res.status(400).json({ error: 'A chore title and price in cents are required' });
    }

    const title = body.title.trim();
    const description = body.description ?? '';
    const priceCents = body.price_cents;
    const dueDate = body.due_date ?? null;
    const assignedTo = body.assigned_to === undefined || body.assigned_to === null || body.assigned_to === ''
      ? null
      : body.assigned_to;

    if (!title || title.length > 150) {
      return res.status(400).json({ error: 'Chore title must be between 1 and 150 characters' });
    }
    if (typeof description !== 'string' || description.length > 2000) {
      return res.status(400).json({ error: 'Chore description must be text no longer than 2000 characters' });
    }
    if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > MAX_PRICE_CENTS) {
      return res.status(400).json({ error: 'Chore price must be a non-negative whole number of cents' });
    }
    if (!validDate(dueDate)) {
      return res.status(400).json({ error: 'Due date must be a valid calendar date' });
    }
    if (assignedTo !== null && (typeof assignedTo !== 'string' || !UUID_PATTERN.test(assignedTo))) {
      return res.status(400).json({ error: 'Assignee must be a valid household member' });
    }

    try {
      const householdId = await getHouseholdId(req.user.id);
      if (!householdId) return res.status(403).json({ error: 'Your account is not part of a household' });

      if (assignedTo) {
        const assignee = await pool.query(
          'SELECT id FROM users WHERE id = $1 AND household_id = $2',
          [assignedTo, householdId]
        );
        if (assignee.rows.length === 0) {
          return res.status(400).json({ error: 'Assignee must belong to your household' });
        }
      }

      const inserted = await pool.query(
        `INSERT INTO chores (household_id, title, description, price_cents, created_by, assigned_to, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [householdId, title, description.trim() || null, priceCents, req.user.id, assignedTo, dueDate || null]
      );
      const result = await pool.query(
        `${choreSelection} WHERE c.id = $1 AND c.household_id = $2`,
        [inserted.rows[0].id, householdId]
      );
      return res.status(201).json({ chore: result.rows[0] });
    } catch {
      return res.status(500).json({ error: 'Unable to create chore' });
    }
  }

  async function complete(req, res) {
    if (!validChoreId(req.params.id)) return res.status(404).json({ error: 'Chore not found' });

    let client;
    let transactionStarted = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      transactionStarted = true;

      const user = await client.query(
        'SELECT household_id FROM users WHERE id = $1 FOR SHARE',
        [req.user.id]
      );
      const householdId = user.rows[0]?.household_id;
      if (!householdId) throw new ChoreActionError('Your account is not part of a household', 403);

      const choreResult = await client.query(
        'SELECT * FROM chores WHERE id = $1 AND household_id = $2 FOR UPDATE',
        [req.params.id, householdId]
      );
      const choreRow = choreResult.rows[0];
      if (!choreRow) throw new ChoreActionError('Chore not found', 404);
      if (choreRow.status !== 'open') throw new ChoreActionError('Only open chores can be completed', 409);
      if (!choreRow.assigned_to) throw new ChoreActionError('Claim this chore before completing it', 409);
      if (choreRow.assigned_to !== req.user.id) {
        throw new ChoreActionError('Only the assigned roommate can complete this chore', 409);
      }

      await client.query(
        `UPDATE chores SET status = 'completed', settlement_type = 'household_iou', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [req.params.id]
      );
      await createHouseholdExpenseIous(client, {
        householdId,
        creditorId: req.user.id,
        amountCents: choreRow.price_cents,
        description: `Chore: ${choreRow.title}`,
        sourceType: 'chore',
        sourceId: choreRow.id
      });

      const chore = await client.query(
        `${choreSelection} WHERE c.id = $1 AND c.household_id = $2`,
        [req.params.id, householdId]
      );
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(200).json({ chore: chore.rows[0] });
    } catch (error) {
      if (client && transactionStarted) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof ChoreActionError) return res.status(error.statusCode).json({ error: error.message });
      return res.status(500).json({ error: 'Unable to complete chore' });
    } finally {
      if (client) client.release();
    }
  }

  async function update(req, res) {
    if (!isObject(req.body) || req.body.status !== 'completed') {
      return res.status(400).json({ error: 'Only completion updates are supported' });
    }
    return complete(req, res);
  }

  async function offer(req, res) {
    if (!validChoreId(req.params.id)) return res.status(404).json({ error: 'Chore not found' });

    try {
      const householdId = await getHouseholdId(req.user.id);
      if (!householdId) return res.status(403).json({ error: 'Your account is not part of a household' });

      const result = await pool.query(
        `UPDATE chores SET assigned_to = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND household_id = $2 AND status = 'open' AND assigned_to = $3
         RETURNING id`,
        [req.params.id, householdId, req.user.id]
      );
      if (result.rows.length === 0) {
        const existing = await pool.query(
          'SELECT status, assigned_to FROM chores WHERE id = $1 AND household_id = $2',
          [req.params.id, householdId]
        );
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Chore not found' });
        return res.status(409).json({ error: 'Only your open assigned chores can be offered' });
      }

      const chore = await pool.query(
        `${choreSelection} WHERE c.id = $1 AND c.household_id = $2`,
        [req.params.id, householdId]
      );
      return res.status(200).json({ chore: chore.rows[0] });
    } catch {
      return res.status(500).json({ error: 'Unable to offer chore' });
    }
  }

  async function claim(req, res) {
    if (!validChoreId(req.params.id)) return res.status(404).json({ error: 'Chore not found' });

    try {
      const householdId = await getHouseholdId(req.user.id);
      if (!householdId) return res.status(403).json({ error: 'Your account is not part of a household' });

      const result = await pool.query(
        `UPDATE chores SET assigned_to = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND household_id = $2 AND status = 'open'
           AND assigned_to IS NULL AND created_by <> $3
         RETURNING id`,
        [req.params.id, householdId, req.user.id]
      );
      if (result.rows.length === 0) {
        const existing = await pool.query(
          'SELECT status, assigned_to, created_by FROM chores WHERE id = $1 AND household_id = $2',
          [req.params.id, householdId]
        );
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Chore not found' });
        return res.status(409).json({ error: 'This chore is not available for pickup' });
      }

      const chore = await pool.query(
        `${choreSelection} WHERE c.id = $1 AND c.household_id = $2`,
        [req.params.id, householdId]
      );
      return res.status(200).json({ chore: chore.rows[0] });
    } catch {
      return res.status(500).json({ error: 'Unable to claim chore' });
    }
  }

  async function remove(req, res) {
    if (!validChoreId(req.params.id)) return res.status(404).json({ error: 'Open chore not found' });

    try {
      const householdId = await getHouseholdId(req.user.id);
      if (!householdId) return res.status(403).json({ error: 'Your account is not part of a household' });

      const result = await pool.query(
        `DELETE FROM chores
         WHERE id = $1 AND household_id = $2 AND created_by = $3 AND status = 'open'
         RETURNING id`,
        [req.params.id, householdId, req.user.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Open chore not found' });
      return res.status(204).end();
    } catch {
      return res.status(500).json({ error: 'Unable to delete chore' });
    }
  }

  return { list, create, complete, update, offer, claim, remove };
}

exports.createChoreController = createChoreController;