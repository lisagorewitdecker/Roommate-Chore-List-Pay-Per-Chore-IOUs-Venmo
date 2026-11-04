const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PRICE_CENTS = 2147483647;
const { createHouseholdExpenseIous } = require('./householdExpenses.cjs');

const supplySelection = `
  SELECT s.id, s.household_id, s.name, s.quantity, s.price_cents, s.created_by,
         s.assigned_to, s.beneficiary_id, s.purchased_by, s.actual_price_cents, s.purchased_at, s.created_at,
         CASE WHEN assignee.id IS NULL THEN NULL
           ELSE json_build_object('id', assignee.id, 'name', assignee.name)
         END AS assigned_member,
         CASE WHEN beneficiary.id IS NULL THEN NULL
           ELSE json_build_object('id', beneficiary.id, 'name', beneficiary.name)
         END AS beneficiary,
         creator.name AS created_by_name
  FROM cleaning_supplies s
  LEFT JOIN users assignee ON assignee.id = s.assigned_to
  LEFT JOIN users beneficiary ON beneficiary.id = s.beneficiary_id
  LEFT JOIN users creator ON creator.id = s.created_by
`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAssignee(value) {
  return value === undefined || value === null || value === '' ? null : value;
}

function validPrice(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= MAX_PRICE_CENTS);
}

class SupplyActionError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function createSupplyController(pool) {
  async function getHouseholdId(userId) {
    const result = await pool.query('SELECT household_id FROM users WHERE id = $1', [userId]);
    return result.rows[0]?.household_id || null;
  }

  async function validateAssignee(assignedTo, householdId) {
    if (assignedTo === null) return true;
    if (typeof assignedTo !== 'string' || !UUID_PATTERN.test(assignedTo)) return false;
    const result = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND household_id = $2',
      [assignedTo, householdId]
    );
    return result.rows.length > 0;
  }

  async function list(req, res) {
    try {
      const householdId = await getHouseholdId(req.user.id);
      if (!householdId) return res.status(403).json({ error: 'Your account is not part of a household' });

      const [supplies, members] = await Promise.all([
        pool.query(
          `${supplySelection} WHERE s.household_id = $1 AND s.purchased_at IS NULL ORDER BY s.created_at, s.id`,
          [householdId]
        ),
        pool.query(
          'SELECT id, name FROM users WHERE household_id = $1 ORDER BY name, id',
          [householdId]
        )
      ]);
      return res.status(200).json({ supplies: supplies.rows, members: members.rows });
    } catch {
      return res.status(500).json({ error: 'Unable to load cleaning supplies' });
    }
  }

  async function create(req, res) {
    const body = req.body;
    if (!isObject(body) || typeof body.name !== 'string') {
      return res.status(400).json({ error: 'A supply name is required' });
    }

    const name = body.name.trim();
    const quantity = body.quantity ?? '';
    const priceCents = body.price_cents === undefined || body.price_cents === '' ? null : body.price_cents;
    const assignedTo = normalizeAssignee(body.assigned_to);
    const beneficiaryId = normalizeAssignee(body.beneficiary_id);
    if (!name || name.length > 150) {
      return res.status(400).json({ error: 'Supply name must be between 1 and 150 characters' });
    }
    if (typeof quantity !== 'string' || quantity.length > 100) {
      return res.status(400).json({ error: 'Supply quantity must be text no longer than 100 characters' });
    }
    if (!validPrice(priceCents)) {
      return res.status(400).json({ error: 'Supply cost must be a non-negative whole number of cents' });
    }

    try {
      const householdId = await getHouseholdId(req.user.id);
      if (!householdId) return res.status(403).json({ error: 'Your account is not part of a household' });
      if (!await validateAssignee(assignedTo, householdId)) {
        return res.status(400).json({ error: 'Assigned buyer must belong to your household' });
      }
      if (!await validateAssignee(beneficiaryId, householdId)) {
        return res.status(400).json({ error: 'Individual beneficiary must belong to your household' });
      }

      const inserted = await pool.query(
        `INSERT INTO cleaning_supplies (household_id, name, quantity, price_cents, assigned_to, beneficiary_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [householdId, name, quantity.trim() || null, priceCents, assignedTo, beneficiaryId, req.user.id]
      );
      const supply = await pool.query(
        `${supplySelection} WHERE s.id = $1 AND s.household_id = $2`,
        [inserted.rows[0].id, householdId]
      );
      return res.status(201).json({ supply: supply.rows[0] });
    } catch {
      return res.status(500).json({ error: 'Unable to add cleaning supply' });
    }
  }

  async function update(req, res) {
    if (!UUID_PATTERN.test(req.params.id) || !isObject(req.body)) {
      return res.status(400).json({ error: 'A valid supply and buyer or cost update are required' });
    }
    const hasAssignee = Object.prototype.hasOwnProperty.call(req.body, 'assigned_to');
    const hasPrice = Object.prototype.hasOwnProperty.call(req.body, 'price_cents');
    const hasBeneficiary = Object.prototype.hasOwnProperty.call(req.body, 'beneficiary_id');
    if (!hasAssignee && !hasPrice && !hasBeneficiary) {
      return res.status(400).json({ error: 'Provide a buyer, beneficiary, or cost to update' });
    }

    const assignedTo = hasAssignee ? normalizeAssignee(req.body.assigned_to) : undefined;
    const beneficiaryId = hasBeneficiary ? normalizeAssignee(req.body.beneficiary_id) : undefined;
    const priceCents = hasPrice
      ? (req.body.price_cents === '' ? null : req.body.price_cents)
      : undefined;
    if (hasPrice && !validPrice(priceCents)) {
      return res.status(400).json({ error: 'Supply cost must be a non-negative whole number of cents' });
    }

    try {
      const householdId = await getHouseholdId(req.user.id);
      if (!householdId) return res.status(403).json({ error: 'Your account is not part of a household' });
      if (hasAssignee && !await validateAssignee(assignedTo, householdId)) {
        return res.status(400).json({ error: 'Assigned buyer must belong to your household' });
      }
      if (hasBeneficiary && !await validateAssignee(beneficiaryId, householdId)) {
        return res.status(400).json({ error: 'Individual beneficiary must belong to your household' });
      }

      const result = await pool.query(
        `UPDATE cleaning_supplies
         SET assigned_to = CASE WHEN $3::boolean THEN $4::uuid ELSE assigned_to END,
             price_cents = CASE WHEN $5::boolean THEN $6::integer ELSE price_cents END,
             beneficiary_id = CASE WHEN $7::boolean THEN $8::uuid ELSE beneficiary_id END
         WHERE id = $1 AND household_id = $2 AND purchased_at IS NULL
         RETURNING id`,
        [req.params.id, householdId, hasAssignee, assignedTo ?? null, hasPrice, priceCents ?? null,
          hasBeneficiary, beneficiaryId ?? null]
      );
      if (result.rows.length === 0) {
        const existing = await pool.query(
          'SELECT id FROM cleaning_supplies WHERE id = $1 AND household_id = $2 AND purchased_at IS NULL',
          [req.params.id, householdId]
        );
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Active supply not found' });
      }

      const supply = await pool.query(
        `${supplySelection} WHERE s.id = $1 AND s.household_id = $2`,
        [req.params.id, householdId]
      );
      return res.status(200).json({ supply: supply.rows[0] });
    } catch {
      return res.status(500).json({ error: 'Unable to update cleaning supply' });
    }
  }

  async function purchase(req, res) {
    if (!UUID_PATTERN.test(req.params.id)) return res.status(404).json({ error: 'Supply not found' });
    if (!isObject(req.body) || !Number.isSafeInteger(req.body.actual_price_cents)
      || req.body.actual_price_cents < 0 || req.body.actual_price_cents > MAX_PRICE_CENTS) {
      return res.status(400).json({ error: 'Actual purchase cost must be a non-negative whole number of cents' });
    }

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
      if (!householdId) throw new SupplyActionError('Your account is not part of a household', 403);

      const selected = await client.query(
        'SELECT * FROM cleaning_supplies WHERE id = $1 AND household_id = $2 FOR UPDATE',
        [req.params.id, householdId]
      );
      const supply = selected.rows[0];
      if (!supply) throw new SupplyActionError('Supply not found', 404);
      if (supply.purchased_at) throw new SupplyActionError('Supply is already marked as purchased', 409);
      if (supply.assigned_to && supply.assigned_to !== req.user.id) {
        throw new SupplyActionError('Only the assigned buyer can mark this supply as purchased', 403);
      }

      await client.query(
        `UPDATE cleaning_supplies
         SET purchased_at = CURRENT_TIMESTAMP, purchased_by = $2, actual_price_cents = $3
         WHERE id = $1`,
        [req.params.id, req.user.id, req.body.actual_price_cents]
      );
      await createHouseholdExpenseIous(client, {
        householdId,
        creditorId: req.user.id,
        amountCents: req.body.actual_price_cents,
        description: `Supply: ${supply.name}`,
        sourceType: 'supply',
        sourceId: supply.id,
        beneficiaryId: supply.beneficiary_id
      });

      const purchased = await client.query(
        `${supplySelection} WHERE s.id = $1 AND s.household_id = $2`,
        [req.params.id, householdId]
      );
      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(200).json({ success: true, supply: purchased.rows[0] });
    } catch (error) {
      if (client && transactionStarted) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof SupplyActionError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Unable to mark supply as purchased' });
    } finally {
      if (client) client.release();
    }
  }

  return { list, create, update, purchase };
}

exports.createSupplyController = createSupplyController;
