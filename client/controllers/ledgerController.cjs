const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AMOUNT_CENTS = 2147483647;

const iouSelection = `
  SELECT i.id, i.household_id, i.debtor_id, debtor.name AS debtor_name,
         i.creditor_id, creditor.name AS creditor_name, i.amount_cents,
         creditor.venmo_username AS creditor_venmo_username,
         i.description, i.status, i.created_by, i.created_at, i.settled_at
  FROM ious i
  JOIN users debtor ON debtor.id = i.debtor_id
  JOIN users creditor ON creditor.id = i.creditor_id
`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createLedgerController(pool) {
  async function getHouseholdId(userId) {
    const result = await pool.query('SELECT household_id FROM users WHERE id = $1', [userId]);
    return result.rows[0]?.household_id || null;
  }

  async function requireHousehold(req, res) {
    const householdId = await getHouseholdId(req.user.id);
    if (!householdId) {
      res.status(403).json({ error: 'Your account is not part of a household' });
      return null;
    }
    return householdId;
  }

  async function list(req, res) {
    try {
      const householdId = await requireHousehold(req, res);
      if (!householdId) return;
      const [transactions, ious, members, profile] = await Promise.all([
        pool.query(
          `SELECT t.id, t.chore_id, t.payer_id AS from_user, payer.name AS from_user_name,
                  t.payee_id AS to_user, payee.name AS to_user_name, t.amount_cents,
                  t.note AS description, t.created_at, 'completed'::text AS status
           FROM transactions t
           JOIN users payer ON payer.id = t.payer_id
           JOIN users payee ON payee.id = t.payee_id
           WHERE payer.household_id = $1 AND payee.household_id = $1
             AND (t.payer_id = $2 OR t.payee_id = $2)
           ORDER BY t.created_at DESC, t.id DESC`,
          [householdId, req.user.id]
        ),
        pool.query(
          `${iouSelection}
           WHERE i.household_id = $1 AND (i.debtor_id = $2 OR i.creditor_id = $2)
           ORDER BY i.created_at DESC, i.id DESC`,
          [householdId, req.user.id]
        ),
        pool.query(
          'SELECT id, name, venmo_username FROM users WHERE household_id = $1 AND id <> $2 ORDER BY name, id',
          [householdId, req.user.id]
        ),
        pool.query(
          'SELECT venmo_username FROM users WHERE id = $1 AND household_id = $2',
          [req.user.id, householdId]
        )
      ]);
      return res.status(200).json({
        transactions: transactions.rows,
        ious: ious.rows,
        members: members.rows,
        venmo_username: profile.rows[0]?.venmo_username || ''
      });
    } catch {
      return res.status(500).json({ error: 'Unable to load ledger' });
    }
  }

  async function summary(req, res) {
    try {
      const householdId = await requireHousehold(req, res);
      if (!householdId) return;
      const result = await pool.query(
        `${iouSelection}
         WHERE i.household_id = $1 AND i.status = 'pending'
           AND (i.debtor_id = $2 OR i.creditor_id = $2)
         ORDER BY i.created_at, i.id`,
        [householdId, req.user.id]
      );
      const owesMe = [];
      const iOwe = [];
      let owedToMe = 0;
      let iOweOthers = 0;
      for (const iou of result.rows) {
        const amount = Number(iou.amount_cents);
        if (iou.creditor_id === req.user.id) {
          owedToMe += amount;
          owesMe.push({
            from_user: iou.debtor_id,
            user_obj: { name: iou.debtor_name },
            total_cents: amount
          });
        } else {
          iOweOthers += amount;
          iOwe.push({
            to_user: iou.creditor_id,
            user_obj: { name: iou.creditor_name },
            total_cents: amount
          });
        }
      }
      return res.status(200).json({
        summary: { owedToMe, iOweOthers, netBalance: owedToMe - iOweOthers, owesMe, iOwe }
      });
    } catch {
      return res.status(500).json({ error: 'Unable to load ledger summary' });
    }
  }

  async function createIou(req, res) {
    const body = req.body;
    if (!isObject(body)
      || !UUID_PATTERN.test(body.debtor_id || '')
      || !UUID_PATTERN.test(body.creditor_id || '')
      || body.debtor_id === body.creditor_id
      || !Number.isSafeInteger(body.amount_cents)
      || body.amount_cents <= 0
      || body.amount_cents > MAX_AMOUNT_CENTS
      || (body.description !== undefined && body.description !== null && typeof body.description !== 'string')) {
      return res.status(400).json({ error: 'Provide two different household members, a positive whole-cent amount, and an optional text description' });
    }
    if (typeof body.description === 'string' && body.description.trim().length > 255) {
      return res.status(400).json({ error: 'IOU description must not exceed 255 characters' });
    }

    try {
      const householdId = await requireHousehold(req, res);
      if (!householdId) return;
      if (body.debtor_id !== req.user.id && body.creditor_id !== req.user.id) {
        return res.status(403).json({ error: 'You must be one of the people in the IOU' });
      }
      const participants = await pool.query(
        'SELECT id FROM users WHERE id = ANY($1::uuid[]) AND household_id = $2',
        [[body.debtor_id, body.creditor_id], householdId]
      );
      if (participants.rows.length !== 2) {
        return res.status(400).json({ error: 'Both IOU participants must belong to your household' });
      }
      const inserted = await pool.query(
        `INSERT INTO ious (household_id, debtor_id, creditor_id, amount_cents, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [householdId, body.debtor_id, body.creditor_id, body.amount_cents,
          typeof body.description === 'string' ? body.description.trim() || null : null, req.user.id]
      );
      const created = await pool.query(
        `${iouSelection} WHERE i.id = $1 AND i.household_id = $2`,
        [inserted.rows[0].id, householdId]
      );
      return res.status(201).json({ iou: created.rows[0] });
    } catch {
      return res.status(500).json({ error: 'Unable to create IOU' });
    }
  }

  async function markPaid(req, res) {
    if (!UUID_PATTERN.test(req.params.id || '')) {
      return res.status(400).json({ error: 'A valid IOU ID is required' });
    }
    try {
      const householdId = await requireHousehold(req, res);
      if (!householdId) return;
      const updated = await pool.query(
        `UPDATE ious SET status = 'paid', settled_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND household_id = $2 AND creditor_id = $3 AND status = 'pending'
         RETURNING id`,
        [req.params.id, householdId, req.user.id]
      );
      if (updated.rowCount === 0) {
        const existing = await pool.query(
          'SELECT creditor_id, status FROM ious WHERE id = $1 AND household_id = $2',
          [req.params.id, householdId]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'IOU not found' });
        if (existing.rows[0].creditor_id !== req.user.id) {
          return res.status(403).json({ error: 'Only the creditor can confirm an IOU as paid' });
        }
        return res.status(409).json({ error: 'IOU is already marked as paid' });
      }
      const paid = await pool.query(
        `${iouSelection} WHERE i.id = $1 AND i.household_id = $2`,
        [req.params.id, householdId]
      );
      return res.status(200).json({ iou: paid.rows[0] });
    } catch {
      return res.status(500).json({ error: 'Unable to mark IOU as paid' });
    }
  }

  async function updateVenmo(req, res) {
    if (!isObject(req.body)
      || (req.body.venmo_username !== null && typeof req.body.venmo_username !== 'string')) {
      return res.status(400).json({ error: 'Venmo username must be text or empty' });
    }
    const rawUsername = typeof req.body.venmo_username === 'string'
      ? req.body.venmo_username.trim().replace(/^@/, '')
      : '';
    if (rawUsername.length > 30 || (rawUsername && !/^[A-Za-z0-9_-]+$/.test(rawUsername))) {
      return res.status(400).json({ error: 'Use a Venmo username containing only letters, numbers, underscores, or hyphens' });
    }

    try {
      const householdId = await requireHousehold(req, res);
      if (!householdId) return;
      const updated = await pool.query(
        'UPDATE users SET venmo_username = $1 WHERE id = $2 AND household_id = $3 RETURNING venmo_username',
        [rawUsername || null, req.user.id, householdId]
      );
      if (updated.rowCount === 0) return res.status(403).json({ error: 'Your account is not part of a household' });
      return res.status(200).json({ venmo_username: updated.rows[0].venmo_username || '' });
    } catch {
      return res.status(500).json({ error: 'Unable to update Venmo username' });
    }
  }

  return { list, summary, createIou, markPaid, updateVenmo };
}

module.exports = { createLedgerController };