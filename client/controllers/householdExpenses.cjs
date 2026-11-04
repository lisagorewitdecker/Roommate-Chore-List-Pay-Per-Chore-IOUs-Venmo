const SOURCE_COLUMNS = Object.freeze({
  chore: 'source_chore_id',
  supply: 'source_supply_id'
});

async function createHouseholdExpenseIous(client, {
  householdId,
  creditorId,
  amountCents,
  description,
  sourceType,
  sourceId,
  beneficiaryId = null
}) {
  const sourceColumn = SOURCE_COLUMNS[sourceType];
  if (!sourceColumn) throw new Error('Unsupported household expense source');

  const membersResult = await client.query(
    'SELECT id FROM users WHERE household_id = $1 ORDER BY id FOR SHARE',
    [householdId]
  );
  const memberIds = membersResult.rows.map(member => member.id);
  if (!memberIds.includes(creditorId)) throw new Error('Expense creditor must belong to the household');

  let shares;
  if (beneficiaryId !== null) {
    if (!memberIds.includes(beneficiaryId)) throw new Error('Expense beneficiary must belong to the household');
    shares = [[beneficiaryId, amountCents]];
  } else {
    const baseShare = Math.floor(amountCents / memberIds.length);
    const remainder = amountCents % memberIds.length;
    shares = memberIds.map((memberId, index) => [memberId, baseShare + (index < remainder ? 1 : 0)]);
  }

  for (const [debtorId, shareCents] of shares) {
    if (debtorId === creditorId || shareCents === 0) continue;
    await client.query(
      `INSERT INTO ious
        (household_id, debtor_id, creditor_id, amount_cents, description, created_by, ${sourceColumn})
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [householdId, debtorId, creditorId, shareCents, description, creditorId, sourceId]
    );
  }
}

module.exports = { createHouseholdExpenseIous };