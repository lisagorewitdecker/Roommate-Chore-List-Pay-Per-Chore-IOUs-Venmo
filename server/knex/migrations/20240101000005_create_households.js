'use strict';

/**
 * Migration: Create households and associate users with a household
 */

exports.up = async function (knex) {
  await knex.schema.createTable('households', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.timestamps(true, true);
  });

  return knex.schema.alterTable('users', (table) => {
    table.uuid('household_id').references('id').inTable('households').onDelete('SET NULL');
    table.index('household_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('household_id');
  });

  return knex.schema.dropTable('households');
};
