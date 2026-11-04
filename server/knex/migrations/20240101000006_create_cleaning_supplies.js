'use strict';

/**
 * Migration: Create cleaning_supplies table
 */

exports.up = function (knex) {
  return knex.schema.createTable('cleaning_supplies', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('household_id').notNullable().references('id').inTable('households').onDelete('CASCADE');
    table.string('name').notNullable();
    table.string('quantity');
    table.integer('price_cents');
    table.uuid('created_by').notNullable().references('id').inTable('users');
    table.uuid('assigned_to').references('id').inTable('users').onDelete('SET NULL');
    table.uuid('beneficiary_id').references('id').inTable('users').onDelete('SET NULL');
    table.uuid('purchased_by').references('id').inTable('users').onDelete('SET NULL');
    table.integer('actual_price_cents');
    table.dateTime('purchased_at');
    table.timestamps(true, true);

    table.index(['household_id', 'purchased_at', 'created_at']);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('cleaning_supplies');
};
