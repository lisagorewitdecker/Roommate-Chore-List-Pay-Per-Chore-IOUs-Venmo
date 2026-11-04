'use strict';

exports.up = function (knex) {
  return knex.schema.createTable('ious', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('household_id').notNullable().references('id').inTable('households').onDelete('CASCADE');
    table.uuid('debtor_id').notNullable().references('id').inTable('users');
    table.uuid('creditor_id').notNullable().references('id').inTable('users');
    table.integer('amount_cents').notNullable();
    table.uuid('source_chore_id').references('id').inTable('chores').onDelete('SET NULL');
    table.uuid('source_supply_id').references('id').inTable('cleaning_supplies').onDelete('SET NULL');
    table.string('description', 255);
    table.string('status', 10).notNullable().defaultTo('pending');
    table.uuid('created_by').notNullable().references('id').inTable('users');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('settled_at', { useTz: true });

    table.check('amount_cents > 0');
    table.check('debtor_id <> creditor_id');
    table.check('created_by = debtor_id OR created_by = creditor_id');
    table.check("(status IN ('pending', 'paid'))");
    table.check("(status = 'pending' AND settled_at IS NULL) OR (status = 'paid' AND settled_at IS NOT NULL)");

    table.index(['household_id', 'status', 'created_at'], 'idx_ious_household_status');
    table.index(['debtor_id', 'creditor_id'], 'idx_ious_participants');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('ious');
};
