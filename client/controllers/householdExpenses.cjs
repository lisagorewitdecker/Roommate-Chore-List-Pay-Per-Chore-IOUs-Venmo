async function createHouseholdExpenseIous(client, {
  householdId,
  creditorId,
  amountCents,
  description,
  sourceType,
  beneficiaryId
}) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return [];

  const members = await client.query(
    'SELECT id FROM users WHERE household_id = $1 ORDER BY id',
    [householdId]
  );
  const memberIds = members.rows.map(({ id }) => id);

  if (beneficiaryId) {
    if (!memberIds.includes(beneficiaryId)) {
      throw new Error('Expense beneficiary does not belong to the household');
    }
    if (beneficiaryId === creditorId) return [];

    return client.query(
      `INSERT INTO ledger_transactions (from_user, to_user, amount_cents, type, description, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [beneficiaryId, creditorId, amountCents, `${sourceType}_expense`, description]
    );
  }

  if (!memberIds.includes(creditorId)) {
    throw new Error('Expense creditor does not belong to the household');
  }

  const share = Math.floor(amountCents / memberIds.length);
  const remainder = amountCents % memberIds.length;
  const transactions = [];

  for (const [index, memberId] of memberIds.entries()) {
    if (memberId === creditorId) continue;
    const memberShare = share + (index < remainder ? 1 : 0);
    if (memberShare === 0) continue;

    transactions.push(await client.query(
      `INSERT INTO ledger_transactions (from_user, to_user, amount_cents, type, description, status)
       VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [memberId, creditorId, memberShare, `${sourceType}_expense`, description]
    ));
  }

  return transactions;
}

exports.createHouseholdExpenseIous = createHouseholdExpenseIous;
