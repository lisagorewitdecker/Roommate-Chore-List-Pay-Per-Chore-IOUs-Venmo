'use strict';

exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE cleaning_supplies
      ALTER COLUMN name TYPE VARCHAR(150),
      ALTER COLUMN quantity TYPE VARCHAR(100),
      ALTER COLUMN created_by DROP NOT NULL
  `);
  await knex.raw('ALTER TABLE cleaning_supplies DROP CONSTRAINT cleaning_supplies_created_by_foreign');
  await knex.raw(`
    ALTER TABLE cleaning_supplies
      ADD CONSTRAINT cleaning_supplies_created_by_foreign
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE cleaning_supplies
      ADD CONSTRAINT cleaning_supplies_price_cents_nonnegative_check
      CHECK (price_cents IS NULL OR price_cents >= 0)
  `);
};

exports.down = async function (knex) {
  await knex.raw('ALTER TABLE cleaning_supplies DROP CONSTRAINT cleaning_supplies_price_cents_nonnegative_check');
  await knex.raw('ALTER TABLE cleaning_supplies DROP CONSTRAINT cleaning_supplies_created_by_foreign');
  await knex.raw(`
    ALTER TABLE cleaning_supplies
      ALTER COLUMN name TYPE VARCHAR,
      ALTER COLUMN quantity TYPE VARCHAR,
      ALTER COLUMN created_by SET NOT NULL
  `);
  await knex.raw(`
    ALTER TABLE cleaning_supplies
      ADD CONSTRAINT cleaning_supplies_created_by_foreign
      FOREIGN KEY (created_by) REFERENCES users(id)
  `);
};
