/**
 * Validation command execution with real processes: success, failure, timeout with
 * process-tree kill and partial output, and a timed-out post-implementation run in the
 * real pipeline (Bob is the test-only fake; its "implementation" creates the HANG marker).
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000 });
vi.mock('../src/ws/EventBus', () => ({ emitEvent: () => undefined }));
process.env['DB_PATH'] = ':memory:';

import { getDatabase } from '../src/db/database';
import { MissionOrchestrator, executeCommand } from '../src/pipeline/MissionOrchestrator';
import { loadReleaseVerdict } from '../src/pipeline/releaseVerdict';
import { FakeBobClient } from './helpers/fakeBob';
import { cleanupRepos, makeRepo } from './helpers/gitRepo';

const SCRIPTS: Record<string, string> = {
  '.gitignore': 'hang.pid\n',
  'package.json': JSON.stringify({
    name: 'timeout-fixture', private: true,
    scripts: {
      lint: 'node scripts/ok.js',
      test: 'node scripts/fail.js',
      typecheck: 'node scripts/maybe-hang.js',
      build: 'node scripts/ok.js',
    },
  }, null, 2),
  'scripts/ok.js': "console.log('ok-output');\n",
  'scripts/fail.js': "console.error('failing-test-output'); process.exit(3);\n",
  'scripts/maybe-hang.js': [
    "const fs = require('fs');",
    "if (!fs.existsSync('HANG')) { console.log('typecheck ok'); process.exit(0); }",
    "fs.writeFileSync('hang.pid', String(process.pid));",
    "process.stdout.write('partial-out before hang\\n');",
    "process.stderr.write('partial-err before hang\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n'),
};

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let fixture: string;
beforeAll(() => { getDatabase(); fixture = makeRepo(SCRIPTS); });
afterAll(() => { cleanupRepos(); });

describe('executeCommand (real processes)', () => {
  it('1. successful command: exit 0, stdout captured', async () => {
    const r = await executeCommand('npm run lint', fixture, 'post', 60_000);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(r.stdout).toContain('ok-output');
  });

  it('2. failing command: its real exit code and stderr', async () => {
    const r = await executeCommand('npm test', fixture, 'post', 60_000);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('failing-test-output');
  });

  it('3 + 4. timeout: process tree killed, exit code null, partial stdout/stderr preserved', async () => {
    fs.writeFileSync(path.join(fixture, 'HANG'), '');
    try {
      const started = Date.now();
      const r = await executeCommand('npm run typecheck', fixture, 'post', 4_000);
      const elapsed = Date.now() - started;
      expect(r).toMatchObject({ exitCode: null, timedOut: true });
      expect(r.stdout).toContain('partial-out before hang');
      expect(r.stderr).toContain('partial-err before hang');
      expect(elapsed).toBeGreaterThanOrEqual(4_000);
      expect(elapsed).toBeLessThan(4_000 + 10_000);
      // The grandchild (node under npm under the shell) must be gone, not orphaned.
      const pid = Number(fs.readFileSync(path.join(fixture, 'hang.pid'), 'utf-8'));
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000, interval: 200 });
    } finally {
      fs.rmSync(path.join(fixture, 'HANG'), { force: true });
    }
  });
});

describe('5. timeout in the pipeline (real executor)', () => {
  it('post-implementation timeout fails the validation phase and blocks the release', async () => {
    const repo = makeRepo({ ...SCRIPTS, 'scripts/fail.js': "console.log('tests pass');\n" });
    process.env['FORGEGUARD_ALLOWED_REPOS'] = repo;
    const id = 'timeout-mission';
    getDatabase().prepare(`INSERT INTO missions (id, issue_text, repo_path, status) VALUES (?, 'x', ?, 'created')`).run(id, repo);
    const bob = new FakeBobClient({ onImplement: (ws) => fs.writeFileSync(path.join(ws, 'HANG'), '') });
    const orch = new MissionOrchestrator({ bobClient: bob, validationTimeoutMs: 4_000, approvalPollIntervalMs: 20, approvalTimeoutMs: 30_000 });
    const timer = setInterval(() => getDatabase().prepare(`UPDATE missions SET plan_approved = 1 WHERE id = ? AND status = 'awaiting_approval'`).run(id), 20);
    try {
      await orch.run(id);
    } finally {
      clearInterval(timer);
    }

    const runs = getDatabase().prepare('SELECT run_kind, command, exit_code, timed_out, passed, stdout, duration_ms FROM validation_runs WHERE mission_id = ? ORDER BY rowid').all(id) as Array<Record<string, unknown>>;
    expect(runs.filter((r) => r['run_kind'] === 'baseline').every((r) => r['exit_code'] === 0 && r['timed_out'] === 0)).toBe(true);
    const hung = runs.find((r) => r['run_kind'] === 'post' && r['command'] === 'npm run typecheck')!;
    expect(hung).toMatchObject({ exit_code: null, timed_out: 1, passed: 0 });
    expect(String(hung['stdout'])).toContain('partial-out before hang');
    expect(Number(hung['duration_ms'])).toBeGreaterThanOrEqual(4_000);

    const phase = getDatabase().prepare(`SELECT status, error_message FROM pipeline_phases WHERE mission_id = ? AND phase_name = 'validation'`).get(id) as { status: string; error_message: string };
    expect(phase.status).toBe('failed');
    expect(phase.error_message).toMatch(/"npm run typecheck" timed out after implementation/);
    expect(loadReleaseVerdict(getDatabase(), id).verdict).toBe('blocked');
    expect(bob.calls).not.toContain('release_engineer');

    const pid = Number(fs.readFileSync(path.join(repo, 'hang.pid'), 'utf-8'));
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000, interval: 200 });
  });
});
