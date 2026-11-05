const { readFileSync } = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const projectRoot = path.resolve(__dirname, '../..');
const expectedTables = ['households', 'users', 'chores', 'transactions'];

function parseEnvFile(filePath) {
  try {
    return dotenv.parse(readFileSync(filePath));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function loadEnvironmentFiles(root = projectRoot) {
  return {
    regularEnv: {
      ...parseEnvFile(path.join(root, '.env')),
      ...parseEnvFile(path.join(root, 'client', '.env'))
    },
    testEnv: parseEnvFile(path.join(root, '.env.test'))
  };
}

function parsePostgresUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL connection URL.`);
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error(`${label} must be a PostgreSQL URL with a hostname.`);
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error(`${label} must contain a valid database name.`);
  }

  if (!databaseName || databaseName.includes('/')) {
    throw new Error(`${label} must contain exactly one database name.`);
  }

  return { url, databaseName };
}

function deriveTestDatabaseUrl(databaseUrl) {
  const { url } = parsePostgresUrl(databaseUrl, 'DATABASE_URL');
  url.pathname = '/roommate_test_db';
  return url.toString();
}

function validateTestDatabaseUrl(testDatabaseUrl, developmentDatabaseUrl) {
  const { url, databaseName } = parsePostgresUrl(testDatabaseUrl, 'TEST_DATABASE_URL');
  if (!/^[a-z][a-z0-9_]{0,62}$/i.test(databaseName) || !/(^|_)test(_|$)/i.test(databaseName)) {
    throw new Error('TEST_DATABASE_URL must use a safe database name containing a standalone "test" segment.');
  }
  if (['postgres', 'template0', 'template1'].includes(databaseName.toLowerCase())) {
    throw new Error('TEST_DATABASE_URL cannot target a PostgreSQL system database.');
  }

  if (developmentDatabaseUrl) {
    const development = parsePostgresUrl(developmentDatabaseUrl, 'DATABASE_URL');
    const sameServer = url.hostname.toLowerCase() === development.url.hostname.toLowerCase()
      && (url.port || '5432') === (development.url.port || '5432');
    if (sameServer && databaseName === development.databaseName) {
      throw new Error('TEST_DATABASE_URL must not point to the database configured by DATABASE_URL.');
    }
  }

  return { url, databaseName };
}

function resolveTestDatabaseUrl({ env = process.env, regularEnv = {}, testEnv = {} } = {}) {
  let testDatabaseUrl;
  if (env.TEST_DATABASE_URL) {
    testDatabaseUrl = env.TEST_DATABASE_URL;
  } else if (env.DATABASE_URL) {
    testDatabaseUrl = deriveTestDatabaseUrl(env.DATABASE_URL);
  } else if (regularEnv.TEST_DATABASE_URL) {
    testDatabaseUrl = regularEnv.TEST_DATABASE_URL;
  } else if (regularEnv.DATABASE_URL) {
    testDatabaseUrl = deriveTestDatabaseUrl(regularEnv.DATABASE_URL);
  } else if (testEnv.TEST_DATABASE_URL) {
    testDatabaseUrl = testEnv.TEST_DATABASE_URL;
  } else if (testEnv.DATABASE_URL) {
    testDatabaseUrl = deriveTestDatabaseUrl(testEnv.DATABASE_URL);
  } else {
    throw new Error('No test database is configured. Set TEST_DATABASE_URL or DATABASE_URL, or configure the root .env.test file.');
  }

  const developmentDatabaseUrl = env.DATABASE_URL || regularEnv.DATABASE_URL || testEnv.DATABASE_URL;
  validateTestDatabaseUrl(testDatabaseUrl, developmentDatabaseUrl);
  return testDatabaseUrl;
}

async function ensureTestDatabase(testDatabaseUrl, {
  ClientClass = Client,
  schemaPath = path.join(__dirname, '../database/schema.sql'),
  migrationPath = path.join(__dirname, '../database/migrations/001_cleaning_supplies.sql'),
  iouMigrationPath = path.join(__dirname, '../database/migrations/002_ious.sql'),
  sharedExpensesMigrationPath = path.join(__dirname, '../database/migrations/003_shared_expenses.sql'),
  passwordResetMigrationPath = path.join(__dirname, '../database/migrations/004_password_reset.sql')
} = {}) {
  const { url: targetUrl, databaseName } = validateTestDatabaseUrl(testDatabaseUrl);
  const adminUrl = new URL(targetUrl.toString());
  adminUrl.pathname = '/postgres';

  const adminClient = new ClientClass({ connectionString: adminUrl.toString() });
  await adminClient.connect();
  try {
    const existingDatabase = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName]
    );
    if (existingDatabase.rowCount === 0) {
      try {
        await adminClient.query(`CREATE DATABASE "${databaseName}"`);
        console.log(`Created test database: ${databaseName}`);
      } catch (error) {
        if (error.code !== '42P04') {
          throw error;
        }
      }
    }
  } finally {
    await adminClient.end();
  }

  const testClient = new ClientClass({ connectionString: targetUrl.toString() });
  await testClient.connect();
  let transactionStarted = false;
  try {
    await testClient.query('BEGIN');
    transactionStarted = true;
    await testClient.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`roommate-test-schema:${databaseName}`]);

    const schemaState = await testClient.query(`
      SELECT
        (SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1::text[])) AS expected_table_count,
        (to_regtype('public.chore_status') IS NOT NULL) AS chore_status_exists,
        (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS public_table_count
    `, [expectedTables]);
    const { expected_table_count: tableCount, chore_status_exists: hasChoreStatus, public_table_count: publicTableCount } = schemaState.rows[0];
    const schemaComplete = tableCount === expectedTables.length && hasChoreStatus;

    if (!schemaComplete && (publicTableCount > 0 || hasChoreStatus)) {
      throw new Error('The test database contains a partial application schema; refusing to modify it.');
    }
    if (!schemaComplete) {
      await testClient.query(readFileSync(schemaPath, 'utf8'));
    }
    await testClient.query(readFileSync(migrationPath, 'utf8'));
    await testClient.query(readFileSync(iouMigrationPath, 'utf8'));
    await testClient.query(readFileSync(sharedExpensesMigrationPath, 'utf8'));
    await testClient.query(readFileSync(passwordResetMigrationPath, 'utf8'));

    await testClient.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await testClient.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    await testClient.end();
  }
}

module.exports = {
  deriveTestDatabaseUrl,
  ensureTestDatabase,
  loadEnvironmentFiles,
  resolveTestDatabaseUrl,
  validateTestDatabaseUrl
};