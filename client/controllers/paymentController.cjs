const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function createPaymentController(pool) {
  return async (req, res) => {
    const choreId = req.body?.chore_id ?? req.body?.choreId;
    const authenticatedUserId = req.user?.id;

    if (!uuidPattern.test(choreId || '')) {
      return res.status(400).json({ error: 'A valid chore ID is required' });
    }
    if (!uuidPattern.test(authenticatedUserId || '')) {
      return res.status(401).json({ error: 'Invalid authenticated user' });
    }
    const payerId = authenticatedUserId.toLowerCase();

    let client;
    let transactionStarted = false;

    try {
      client = await pool.connect();
      await client.query('BEGIN');
      transactionStarted = true;

      const choreResult = await client.query(
        'SELECT * FROM chores WHERE id = $1 FOR UPDATE',
        [choreId]
      );
      const chore = choreResult.rows[0];

      if (!chore) throw new PaymentError('Chore not found', 404);
      if (chore.status !== 'completed') throw new PaymentError('Chore is not completed yet');
      if (chore.settlement_type === 'household_iou') {
        throw new PaymentError('This chore is settled through household IOUs, not a wallet transfer', 409);
      }
      if (!chore.assigned_to) throw new PaymentError('Chore is not assigned');
      if (chore.assigned_to === payerId) throw new PaymentError('Cannot pay yourself for a chore');
      if (!Number.isInteger(chore.price_cents) || chore.price_cents <= 0) {
        throw new PaymentError('Chore price must be greater than zero');
      }

      const walletResult = await client.query(
        `SELECT id, household_id, balance_cents
         FROM users
         WHERE id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [[payerId, chore.assigned_to]]
      );
      const wallets = new Map(walletResult.rows.map(wallet => [wallet.id, wallet]));
      const payer = wallets.get(payerId);
      const payee = wallets.get(chore.assigned_to);

      if (!payer) throw new PaymentError('Authenticated user not found', 401);
      if (!payee) throw new PaymentError('Chore assignee not found');
      if (payer.household_id !== chore.household_id || payee.household_id !== chore.household_id) {
        throw new PaymentError('Chore participants must belong to the same household');
      }
      if (payer.balance_cents < chore.price_cents) {
        throw new PaymentError('Insufficient wallet balance');
      }

      await client.query(
        'UPDATE users SET balance_cents = balance_cents - $1 WHERE id = $2',
        [chore.price_cents, payerId]
      );
      await client.query(
        'UPDATE users SET balance_cents = balance_cents + $1 WHERE id = $2',
        [chore.price_cents, chore.assigned_to]
      );
      await client.query(
        "UPDATE chores SET status = 'verified_paid', updated_at = NOW() WHERE id = $1",
        [choreId]
      );

      const transactionResult = await client.query(
        `INSERT INTO transactions (chore_id, payer_id, payee_id, amount_cents, note)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [choreId, payerId, chore.assigned_to, chore.price_cents, `Payout for: ${chore.title}`]
      );

      await client.query('COMMIT');
      transactionStarted = false;
      return res.status(200).json({ success: true, transaction: transactionResult.rows[0] });
    } catch (error) {
      let rollbackFailed = false;
      if (client && transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch {
          rollbackFailed = true;
        }
      }

      if (error instanceof PaymentError && !rollbackFailed) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      return res.status(client ? 500 : 503).json({ error: 'Unable to process payment' });
    } finally {
      if (client) client.release();
    }
  };
}

module.exports = { createPaymentController };