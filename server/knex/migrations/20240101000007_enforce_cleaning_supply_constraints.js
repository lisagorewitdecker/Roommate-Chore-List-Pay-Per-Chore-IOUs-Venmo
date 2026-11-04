'use strict';

exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE cleaning_supplies
      ALTER COLUMN name TYPE VARCHAR(150),
      ALTER COLUMN quantity TYPE VARCHAR(100)
  `);
  return knex.raw(`
    ALTER TABLE cleaning_supplies
      ADD CONSTRAINT cleaning_supplies_price_cents_nonnegative
      CHECK (price_cents IS NULL OR price_cents >= 0)
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE cleaning_supplies
      DROP CONSTRAINT cleaning_supplies_price_cents_nonnegative
  `);
  return knex.raw(`
    ALTER TABLE cleaning_supplies
      ALTER COLUMN name TYPE VARCHAR(255),
      ALTER COLUMN quantity TYPE VARCHAR(255)
  `);
};
