'use strict';

/**
 * Migration: Create chores table
 * Each chore has a cost stored as integer cents to avoid floating-point errors
 */

exports.up = function (knex) {
  return knex.schema.createTable('chores', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('title').notNullable();
    table.text('description');
    table.integer('cost_cents').notNullable().defaultTo(0);
    table.string('frequency').notNullable().defaultTo('once');
    table.uuid('assigned_to').references('id').inTable('users').onDelete('SET NULL');
    table.uuid('created_by').notNullable().references('id').inTable('users');
    table.boolean('is_completed').defaultTo(false);
    table.dateTime('completed_at');
    table.dateTime('due_date');
    table.timestamps(true, true);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('chores');
};
