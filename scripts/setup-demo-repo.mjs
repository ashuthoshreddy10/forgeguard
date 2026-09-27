#!/usr/bin/env node
/**
 * Re-creates demo-app's own Git repository at its original baseline commit.
 *
 * ForgeGuard treats demo-app as the target repository of a mission, and it must be the
 * top level of its own Git repository (rollback anchors, repository lock). In this
 * repository demo-app is tracked as a normal directory, so after cloning run:
 *
 *     node scripts/setup-demo-repo.mjs
 *
 * The result is demo-app/.git with HEAD = fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f, the
 * same commit object as the original baseline. demo-app's files are never modified.
 *   1. Preferred: fetch the original commit from this repository's history (tag demo-app-baseline).
 *   2. Fallback (e.g. a ZIP download without Git history): rebuild the commit from the
 *      tracked files and the original commit metadata. The SHA must still match exactly.
 * If neither produces the exact baseline, the new demo-app/.git is removed again.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'demo-app');
const BASELINE_COMMIT = 'fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f';
const BASELINE_TREE = '54738f4b90cc69f4884efe413faf588f15607636';
const BASELINE_TAG = 'demo-app-baseline';
const AUTHOR = { name: 'SANTHI P', email: 'ashuthoshreddy27@gmail.com', date: '1790434402 +0530' };
const MESSAGE = [
  'Baseline: demo-app with seeded engineering issues (pre-ForgeGuard state)',
  '',
  'Tooling configuration fixed so lint/test/typecheck/build run cleanly; the',
  '10 intentionally seeded issues documented in README.md are unchanged.',
  '',
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  '',
].join('\n');

const git = (cwd, args, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
const tryGit = (cwd, args, opts) => { try { return git(cwd, args, opts); } catch { return null; } };

function fail(msg) {
  console.error(`setup-demo-repo: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(DEMO, 'package.json'))) fail(`demo-app not found at ${DEMO}`);

if (fs.existsSync(path.join(DEMO, '.git'))) {
  const head = tryGit(DEMO, ['rev-parse', 'HEAD']);
  const top = tryGit(DEMO, ['rev-parse', '--show-toplevel']);
  if (head === BASELINE_COMMIT && top && path.resolve(top) === path.resolve(DEMO)) {
    console.log(`demo-app is already its own repository at the baseline ${BASELINE_COMMIT}.`);
    process.exit(0);
  }
  fail(`demo-app/.git already exists (HEAD ${head ?? 'unknown'}). Not touching it; remove it manually to re-create the baseline.`);
}

git(DEMO, ['init', '-q', '-b', 'main']);
const cleanup = (why) => {
  fs.rmSync(path.join(DEMO, '.git'), { recursive: true, force: true });
  fail(why);
};

let method = null;
// 1. Fetch the original commit object from the root repository's history.
if (tryGit(ROOT, ['rev-parse', '--verify', '--quiet', `${BASELINE_TAG}^{commit}`]) === BASELINE_COMMIT) {
  if (tryGit(DEMO, ['fetch', '-q', '--no-tags', ROOT, `refs/tags/${BASELINE_TAG}`]) !== null
      && tryGit(DEMO, ['rev-parse', 'FETCH_HEAD']) === BASELINE_COMMIT) {
    git(DEMO, ['update-ref', 'refs/heads/main', BASELINE_COMMIT]);
    method = `fetched from this repository's history (tag ${BASELINE_TAG})`;
  }
}

// 2. Rebuild the identical commit from the tracked files (line endings normalised to LF, as stored).
if (!method) {
  git(DEMO, ['-c', 'core.autocrlf=input', '-c', 'core.safecrlf=false', 'add', '-A']);
  const tree = git(DEMO, ['write-tree']);
  if (tree !== BASELINE_TREE) {
    cleanup(`demo-app's files do not match the baseline (tree ${tree}, expected ${BASELINE_TREE}); was demo-app modified?`);
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_AUTHOR_DATE: AUTHOR.date,
    GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email, GIT_COMMITTER_DATE: AUTHOR.date,
  };
  const commit = git(DEMO, ['commit-tree', tree, '-F', '-'], { env, input: MESSAGE });
  if (commit !== BASELINE_COMMIT) cleanup(`rebuilt commit ${commit} does not equal the baseline ${BASELINE_COMMIT}`);
  git(DEMO, ['update-ref', 'refs/heads/main', commit]);
  method = 'rebuilt from the tracked files and the original commit metadata';
}

// Point the index at the baseline without touching the working tree, then verify.
git(DEMO, ['reset', '-q', '--mixed', 'HEAD']);
const head = git(DEMO, ['rev-parse', 'HEAD']);
const dirty = git(DEMO, ['status', '--porcelain']);
if (head !== BASELINE_COMMIT) cleanup(`HEAD is ${head}, expected ${BASELINE_COMMIT}`);
console.log(`demo-app repository created: HEAD ${head} (${method}).`);
if (dirty) {
  console.log('Note: demo-app differs from the baseline:\n' + dirty);
} else {
  console.log('demo-app working tree matches the baseline exactly.');
}
