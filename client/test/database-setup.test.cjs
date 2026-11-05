const assert = require('node:assert/strict');
const test = require('node:test');
const {
  deriveTestDatabaseUrl,
  resolveTestDatabaseUrl,
  validateTestDatabaseUrl
} = require('./database-setup.cjs');

test('derives an isolated test database from DATABASE_URL', () => {
  assert.equal(
    deriveTestDatabaseUrl('postgres://roommate_user:secret@localhost:5432/roommate_chore_db'),
    'postgres://roommate_user:secret@localhost:5432/roommate_test_db'
  );
});

test('process DATABASE_URL takes precedence over the local .env.test default', () => {
  const testDatabaseUrl = resolveTestDatabaseUrl({
    env: { DATABASE_URL: 'postgres://dev:secret@localhost:5432/roommate_chore_db' },
    testEnv: { TEST_DATABASE_URL: 'postgres://roommate_user:password@localhost:5432/roommate_test_db' }
  });

  assert.equal(testDatabaseUrl, 'postgres://dev:secret@localhost:5432/roommate_test_db');
});

test('an explicit TEST_DATABASE_URL takes precedence over DATABASE_URL', () => {
  const testDatabaseUrl = resolveTestDatabaseUrl({
    env: {
      DATABASE_URL: 'postgres://dev:secret@localhost:5432/roommate_chore_db',
      TEST_DATABASE_URL: 'postgres://test:secret@localhost:5433/payment_test'
    }
  });

  assert.equal(testDatabaseUrl, 'postgres://test:secret@localhost:5433/payment_test');
});

test('derives from a configured .env DATABASE_URL before using the .env.test default', () => {
  const testDatabaseUrl = resolveTestDatabaseUrl({
    env: {},
    regularEnv: { DATABASE_URL: 'postgres://dev:secret@localhost:5432/chore_app' },
    testEnv: { TEST_DATABASE_URL: 'postgres://test:secret@localhost:5432/payment_test' }
  });

  assert.equal(testDatabaseUrl, 'postgres://dev:secret@localhost:5432/roommate_test_db');
});

test('rejects a test URL that points to the configured development database', () => {
  assert.throws(
    () => validateTestDatabaseUrl(
      'postgres://test:secret@localhost:5432/roommate_test_db',
      'postgres://dev:secret@localhost:5432/roommate_test_db'
    ),
    /must not point to the database configured by DATABASE_URL/
  );
});

test('rejects unsafe or non-test database names', () => {
  for (const databaseName of ['roommate_chore_db', 'roommate-test-db', 'postgres_test;drop']) {
    assert.throws(
      () => validateTestDatabaseUrl(`postgres://test:secret@localhost:5432/${databaseName}`),
      /safe database name/
    );
  }
});

test('rejects invalid and system database URLs', () => {
  assert.throws(() => validateTestDatabaseUrl('not-a-url'), /valid PostgreSQL connection URL/);
  assert.throws(
    () => validateTestDatabaseUrl('postgres://test:secret@localhost:5432/postgres'),
    /safe database name/
  );
});