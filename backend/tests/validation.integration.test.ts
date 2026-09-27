/**
 * Integration: the real validation executor runs the real npm commands in demo-app and
 * persists baseline + post rows. Bob is an in-test fake whose implementer changes nothing,
 * and the rollback anchor is disabled so the demo-app working tree is never stashed.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { BobClient, BobProviderStatus, BobTaskOptions, BobTaskResult } from '../src/bob/BobClient';
import { gitSync } from './helpers/gitRepo';

vi.mock('../src/ws/EventBus', () => ({ emitEvent: () => undefined }));
process.env['DB_PATH'] = ':memory:';

const { getDatabase } = await import('../src/db/database');
const { MissionOrchestrator } = await import('../src/pipeline/MissionOrchestrator');
const { loadReleaseVerdict } = await import('../src/pipeline/releaseVerdict');

const DEMO_APP = path.resolve(__dirname, '../../demo-app');
const hasDemoApp = fs.existsSync(path.join(DEMO_APP, 'node_modules'));

const block = (o: unknown): string => `--- FORGEGUARD:JSON ---\n${JSON.stringify(o)}\n--- END ---`;

class NoOpBob implements BobClient {
  readonly provider = 'shell' as const;
  async checkAvailability(): Promise<BobProviderStatus> { return { provider: 'shell', available: true, version: 'test-fake' }; }
  async runTask(o: BobTaskOptions): Promise<BobTaskResult> {
    let output = block({ summary: 'x', findings: [] });
    if (o.prompt.includes('PlanSynthesizer')) output = block({ summary: 'no-op', steps: [{ order: 1, file: '-', description: 'no-op' }] });
    if (o.prompt.includes('Implementer')) output = 'No changes made (test fake).';
    if (o.prompt.includes('ReleaseEngineer')) output = block({ releaseReadiness: 'ready', summary: 'narrative' });
    const now = new Date().toISOString();
    return { taskId: o.taskId ?? 'x', success: true, exitCode: 0, output, stdout: output, stderr: '', durationMs: 1, startedAt: now, completedAt: now };
  }
}

describe.skipIf(!hasDemoApp)('real validation commands against demo-app', () => {
  it('persists real baseline and post rows and derives the verdict from them', async () => {
    const db = getDatabase();
    const id = 'integration-mission';
    db.prepare(`INSERT INTO missions (id, issue_text, repo_path, status) VALUES (?, 'integration', ?, 'created')`).run(id, DEMO_APP);

    const headBefore = gitSync(DEMO_APP, ['rev-parse', 'HEAD']).trim();
    const orch = new MissionOrchestrator({
      bobClient: new NoOpBob(),
      approvalPollIntervalMs: 20,
      approvalTimeoutMs: 10_000,
    });
    const timer = setInterval(() => db.prepare(`UPDATE missions SET plan_approved = 1 WHERE id = ? AND status = 'awaiting_approval'`).run(id), 20);
    try {
      await orch.run(id);
    } finally {
      clearInterval(timer);
      // Remove this test's anchor/result refs so the demo-app repository is left as it was.
      const refs = gitSync(DEMO_APP, ['for-each-ref', '--format=%(refname)', `refs/forgeguard/anchors/${id}/`, `refs/forgeguard/results/${id}/`])
        .split('\n').filter(Boolean);
      for (const ref of refs) gitSync(DEMO_APP, ['update-ref', '-d', ref]);
    }
    expect(gitSync(DEMO_APP, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(gitSync(DEMO_APP, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(DEMO_APP, '.git', 'forgeguard.lock'))).toBe(false);
    expect(String((db.prepare('SELECT rollback_ref FROM missions WHERE id = ?').get(id) as { rollback_ref: string }).rollback_ref))
      .toMatch(new RegExp(`^refs/forgeguard/anchors/${id}/[0-9a-f]{8}$`));

    const runs = db.prepare(`SELECT run_kind, command, exit_code, passed, stdout, stderr, duration_ms, started_at, completed_at
      FROM validation_runs WHERE mission_id = ? ORDER BY rowid`).all(id) as Array<Record<string, unknown>>;
    console.log(runs.map((r) => `${String(r['run_kind']).padEnd(8)} ${String(r['command']).padEnd(18)} exit=${String(r['exit_code'])} ${String(r['duration_ms'])}ms`).join('\n'));

    expect(runs.map((r) => `${String(r['run_kind'])}:${String(r['command'])}`)).toEqual([
      'baseline:npm run lint', 'baseline:npm test', 'baseline:npm run typecheck', 'baseline:npm run build',
      'post:npm run lint', 'post:npm test', 'post:npm run typecheck', 'post:npm run build',
    ]);
    for (const r of runs) {
      expect(Number.isInteger(r['exit_code'])).toBe(true);
      expect(r['passed']).toBe(r['exit_code'] === 0 ? 1 : 0);
      expect(r['duration_ms']).toBeGreaterThan(0);
      expect(r['completed_at']).toBeTruthy();
    }
    const testRun = runs.find((r) => r['run_kind'] === 'baseline' && r['command'] === 'npm test')!;
    expect(String(testRun['stdout'])).toMatch(/29 passed/);

    const verdict = loadReleaseVerdict(db, id);
    expect(verdict.verdict).toBe('ready');
    expect(db.prepare('SELECT status FROM missions WHERE id = ?').get(id)).toEqual({ status: 'complete' });
  }, 240_000);
});
