const bcrypt = require('bcrypt');

exports.seed = async function (knex) {
  // Clear existing data
  await knex('payment_reminders').del();
  await knex('ledger_transactions').del();
  await knex('chores').del();
  await knex('users').del();

  // Create sample users
  const saltRounds = 10;
  const hashedPassword1 = await bcrypt.hash('password123', saltRounds);
  const hashedPassword2 = await bcrypt.hash('password123', saltRounds);

  const [user1] = await knex('users')
    .insert({
      name: 'Alice Johnson',
      email: 'alice@example.com',
      password_hash: hashedPassword1
    })
    .returning('*');

  const [user2] = await knex('users')
    .insert({
      name: 'Bob Smith',
      email: 'bob@example.com',
      password_hash: hashedPassword2
    })
    .returning('*');

  // Create sample chores
  const [chore1] = await knex('chores')
    .insert({
      title: 'Clean Kitchen',
      description: 'Wipe counters, sweep floor, clean sink',
      cost_cents: 500,
      frequency: 'weekly',
      assigned_to: user1.id,
      created_by: user2.id,
      is_completed: false
    })
    .returning('*');

  const [chore2] = await knex('chores')
    .insert({
      title: 'Take Out Trash',
      description: 'Bring all trash bins to curb and back',
      cost_cents: 300,
      frequency: 'weekly',
      assigned_to: user2.id,
      created_by: user1.id,
      is_completed: true,
      completed_at: new Date()
    })
    .returning('*');

  // Create sample ledger transaction
  await knex('ledger_transactions')
    .insert({
      from_user: user2.id,
      to_user: user1.id,
      amount_cents: 300,
      chore_id: chore2.id,
      type: 'chore_payment',
      description: 'Payment for Take Out Trash',
      status: 'completed'
    });
};
