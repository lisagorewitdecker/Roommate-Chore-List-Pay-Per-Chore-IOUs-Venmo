'use strict';

/**
 * Migration: Create payment_reminders table
 * Tracks scheduled and sent payment reminders
 */

exports.up = function (knex) {
  return knex.schema.createTable('payment_reminders', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('transaction_id').notNullable().references('id').inTable('ledger_transactions');
    table.uuid('from_user').notNullable().references('id').inTable('users');
    table.uuid('to_user').notNullable().references('id').inTable('users');
    table.string('status').notNullable().defaultTo('scheduled');
    table.dateTime('scheduled_for');
    table.dateTime('sent_at');
    table.timestamps(true, true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('payment_reminders');
};
