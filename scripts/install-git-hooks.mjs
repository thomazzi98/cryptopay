#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Installs the git hooks, and does nothing where there are none to install.
 *
 * `npm ci` runs `prepare`, and the production stage of every Docker image runs `npm ci --omit=dev`,
 * which has just removed husky. The lifecycle script then fails with "husky: not found" and the
 * whole image build stops on a step that had nothing to do with the image.
 *
 * The usual fix is `husky || true`, which also swallows a genuine failure on a developer's machine:
 * hooks quietly stop being installed and nobody notices until a bad commit lands. This checks the
 * two conditions that actually distinguish the cases and says which one it found.
 *
 * husky is a local dependency rather than a global one, so PATH is the wrong place to look for it.
 * Asking PATH is how this script got it wrong the first time, and it would have skipped the hooks on
 * every developer machine while reporting success.
 *
 * Its own entry point is run rather than the `.bin` shim, because Node refuses to spawn a `.cmd`
 * without a shell on Windows and running it through one would mean quoting a path that contains
 * spaces on most machines.
 */

const repositoryRoot = join(import.meta.dirname, '..');
const huskyEntry = join(repositoryRoot, 'node_modules', 'husky', 'bin.js');

if (!existsSync(join(repositoryRoot, '.git'))) {
  console.log('No .git directory, so there are no hooks to install.');
  process.exit(0);
}

if (!existsSync(huskyEntry)) {
  console.log('husky is not installed, which is expected in a production install.');
  process.exit(0);
}

const installed = spawnSync(process.execPath, [huskyEntry], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
if (installed.status !== 0) {
  console.error('husky is installed but failed to set up the hooks.');
}
process.exit(installed.status ?? 1);
