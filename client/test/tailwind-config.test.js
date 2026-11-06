import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));
const viteCli = path.join(clientRoot, 'node_modules/vite/bin/vite.js');

test('Tailwind utilities are generated when Vite runs outside the client directory', () => {
  const workingDirectory = mkdtempSync(path.join(os.tmpdir(), 'roommate-tailwind-'));
  const outputDirectory = path.join(workingDirectory, 'dist');

  try {
    const result = spawnSync(process.execPath, [
      viteCli,
      'build',
      clientRoot,
      '--config', path.join(clientRoot, 'vite.config.js'),
      '--outDir', outputDirectory,
      '--emptyOutDir',
      '--logLevel', 'error'
    ], {
      cwd: workingDirectory,
      encoding: 'utf8',
      timeout: 30000
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const css = readdirSync(path.join(outputDirectory, 'assets'))
      .filter(file => file.endsWith('.css'))
      .map(file => readFileSync(path.join(outputDirectory, 'assets', file), 'utf8'))
      .join('\n');

    for (const utility of ['.min-h-screen', '.bg-white', '.shadow-xl', '.w-full']) {
      assert.ok(css.includes(utility), `Expected generated CSS to include ${utility}`);
    }
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});