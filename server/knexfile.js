require('dotenv').config();

module.exports = {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL || 'postgresql://roommate_user:roommate_pass_2024@localhost:5432/roommate_chore_db',
    pool: {
      min: 2,
      max: 10
    },
    migrations: {
      directory: './knex/migrations'
    },
    seeds: {
      directory: './knex/seeds'
    },
    poolConfig: {
      idleTimeoutMillis: 30000,
      createTimeoutMillis: 30000
    }
  },
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: {
      min: 2,
      max: 20
    },
    migrations: {
      directory: './knex/migrations'
    },
    seeds: {
      directory: './knex/seeds'
    }
  }
};
