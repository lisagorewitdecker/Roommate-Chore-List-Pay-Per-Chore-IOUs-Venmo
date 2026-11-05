const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const databaseModule = path.resolve(__dirname, '../db.cjs');

function runDatabaseScript(script, { env = {}, dotenv = '', moduleEnv } = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'database-pool-test-'));
  let temporaryModuleDirectory;
  let modulePath = databaseModule;
  if (dotenv) {
    writeFileSync(path.join(cwd, '.env'), dotenv);
  }
  if (moduleEnv !== undefined) {
    temporaryModuleDirectory = mkdtempSync(path.join(os.tmpdir(), 'database-module-test-'));
    const clientDirectory = path.join(temporaryModuleDirectory, 'client');
    mkdirSync(clientDirectory);
    modulePath = path.join(clientDirectory, 'db.cjs');
    copyFileSync(databaseModule, modulePath);
    writeFileSync(path.join(clientDirectory, '.env'), moduleEnv);
  }

  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  delete childEnv.NODE_ENV;
  Object.assign(childEnv, env);
  childEnv.NODE_PATH = path.resolve(__dirname, '../node_modules');
  childEnv.TEST_DATABASE_MODULE = modulePath;

  try {
    return spawnSync(process.execPath, ['-e', script], {
      cwd,
      env: childEnv,
      encoding: 'utf8'
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (temporaryModuleDirectory) {
      rmSync(temporaryModuleDirectory, { recursive: true, force: true });
    }
  }
}

function readPoolOptions(options) {
  const result = runDatabaseScript(`
    const pool = require(process.env.TEST_DATABASE_MODULE);
    console.log(JSON.stringify({
      connectionString: pool.options.connectionString,
      ssl: pool.options.ssl,
      max: pool.options.max,
      idleTimeoutMillis: pool.options.idleTimeoutMillis,
      connectionTimeoutMillis: pool.options.connectionTimeoutMillis
    }));
  `, options);

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('configures the development pool without SSL and applies pool limits', () => {
  const options = readPoolOptions({
    env: { NODE_ENV: 'development', DATABASE_URL: 'postgres://dev.example/app' }
  });

  assert.equal(options.connectionString, 'postgres://dev.example/app');
  assert.equal(options.ssl, false);
  assert.equal(options.max, 20);
  assert.equal(options.idleTimeoutMillis, 30000);
  assert.equal(options.connectionTimeoutMillis, 2000);
});

test('enables certificate-verified SSL in production', () => {
  const options = readPoolOptions({
    env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://prod.example/app' }
  });

  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
});

test('uses the configured CA certificate in production', () => {
  const options = readPoolOptions({
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://prod.example/app',
      DATABASE_CA_CERT: 'provider CA certificate'
    }
  });

  assert.deepEqual(options.ssl, {
    rejectUnauthorized: true,
    ca: 'provider CA certificate'
  });
});

test('loads DATABASE_URL and NODE_ENV from the module .env outside the working directory', () => {
  const options = readPoolOptions({
    dotenv: 'DATABASE_URL=postgres://working-directory.example/app\nNODE_ENV=development\n',
    moduleEnv: 'DATABASE_URL=postgres://module.example/app\nNODE_ENV=production\n'
  });

  assert.equal(options.connectionString, 'postgres://module.example/app');
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
});

test('keeps existing environment variables ahead of .env values', () => {
  const options = readPoolOptions({
    dotenv: 'DATABASE_URL=postgres://dotenv.example/app\nNODE_ENV=production\n',
    env: { DATABASE_URL: 'postgres://environment.example/app', NODE_ENV: 'development' }
  });

  assert.equal(options.connectionString, 'postgres://environment.example/app');
  assert.equal(options.ssl, false);
});

test('logs unexpected pool errors and exits with a failure code', () => {
  const result = runDatabaseScript(`
    const pool = require(${JSON.stringify(databaseModule)});
    const originalExit = process.exit;
    const originalError = console.error;
    let exitCode;
    const logged = [];
    process.exit = code => { exitCode = code; };
    console.error = (...args) => logged.push(args);
    const error = new Error('idle client failure');
    pool.emit('error', error);
    process.exit = originalExit;
    console.error = originalError;
    console.log(JSON.stringify({ exitCode, logged: logged.map(args => [args[0], args[1].message]) }));
  `, { env: { DATABASE_URL: 'postgres://dev.example/app' } });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    exitCode: -1,
    logged: [['Unexpected database client error:', 'idle client failure']]
  });
});