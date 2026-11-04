'use strict';

/**
 * Migration: Create ledger_transactions table
 * Atomic ledger for tracking IOUs and payments between roommates.
 * All amounts stored as integer cents to prevent floating-point rounding errors.
 */

exports.up = function (knex) {
  return knex.schema.createTable('ledger_transactions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('from_user').notNullable().references('id').inTable('users');
    table.uuid('to_user').notNullable().references('id').inTable('users');
    table.integer('amount_cents').notNullable();
    table.uuid('chore_id').references('id').inTable('chores').onDelete('SET NULL');
    table.string('type').notNullable();
    table.text('description');
    table.string('status').notNullable().defaultTo('pending');
    table.timestamps(true, true);

    // Ensure from_user and to_user are different
    table.check('from_user != to_user');
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('ledger_transactions');
};
