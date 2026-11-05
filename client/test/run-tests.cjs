const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const {
  ensureTestDatabase,
  loadEnvironmentFiles,
  resolveTestDatabaseUrl
} = require('./database-setup.cjs');

async function run() {
  const mode = process.argv[2] || 'all';
  if (!['all', 'integration', 'unit'].includes(mode)) {
    throw new Error(`Unknown test mode "${mode}". Use all, integration, or unit.`);
  }

  const clientRoot = path.resolve(__dirname, '..');
  const projectRoot = path.resolve(clientRoot, '..');
  const { regularEnv, testEnv } = loadEnvironmentFiles(projectRoot);
  const testFiles = readdirSync(__dirname)
    .filter(file => /\.test\.(?:cjs|js|mjs)$/.test(file))
    .filter(file => mode !== 'integration' || file.includes('.integration.test.'))
    .filter(file => mode !== 'unit' || !file.includes('.integration.test.'))
    .sort()
    .map(file => path.join('test', file));

  const childEnv = { ...regularEnv, ...testEnv, ...process.env };
  if (mode !== 'unit') {
    const testDatabaseUrl = resolveTestDatabaseUrl({ env: process.env, regularEnv, testEnv });
    try {
      await ensureTestDatabase(testDatabaseUrl);
    } catch (error) {
      throw new Error(`Test database setup failed: ${error.message}`);
    }
    childEnv.TEST_DATABASE_URL = testDatabaseUrl;
  } else {
    delete childEnv.TEST_DATABASE_URL;
  }

  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
    cwd: clientRoot,
    env: childEnv,
    stdio: 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = result.status;
  }
}

if (!process.env.NODE_TEST_CONTEXT) {
  run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}