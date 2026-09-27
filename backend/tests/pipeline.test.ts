/**
 * Pipeline state-transition tests. Bob is replaced by an in-test FakeBobClient —
 * this fake exists only in tests and is never reachable from the application.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Every mission runs real git plumbing (anchor, snapshots) in a temporary repository.
vi.setConfig({ testTimeout: 30_000 });
import { v4 as uuidv4 } from 'uuid';
import type { ForgeGuardEvent } from '../src/ws/events';
import { FakeBobClient as SharedFakeBob, json, type Behavior } from './helpers/fakeBob';
import fs from 'fs';
import path from 'path';
import { allowRepo, cleanupRepos, gitSync, makeDir, makeRepo, repoState, write } from './helpers/gitRepo';

const events: ForgeGuardEvent[] = [];
vi.mock('../src/ws/EventBus', () => ({
  emitEvent: (e: ForgeGuardEvent) => events.push(e),
  getEventBus: () => { throw new Error('not initialised'); },
}));

process.env['DB_PATH'] = ':memory:';
const SECRET = 'sk-pipeline-SECRET-abcdef';
process.env['BOBSHELL_API_KEY'] = SECRET;

import { getDatabase } from '../src/db/database';
import {
  MissionOrchestrator,
  startMission,
  type CommandExecution,
} from '../src/pipeline/MissionOrchestrator';
import { loadReleaseVerdict, type RunKind } from '../src/pipeline/releaseVerdict';
import { rollbackMission } from '../src/pipeline/rollback';

/** Positional wrapper around the shared test-only fake. */
class FakeBobClient extends SharedFakeBob {
  constructor(behavior: Record<string, Behavior> = {}, available = true, overrides: Record<string, string> = {}) {
    super({ behavior, available, overrides, secret: SECRET });
  }
}

/** Fake command executor (tests only): exit codes per run kind; rows are persisted by the real orchestrator. */
function validationExecutor(failing: Partial<Record<RunKind, Record<string, number>>> = {}) {
  return vi.fn(async (command: string, _cwd: string, kind: RunKind): Promise<CommandExecution> => {
    const exitCode = failing[kind]?.[command] ?? 0;
    return { exitCode, timedOut: false, stdout: exitCode === 0 ? `${command}: ok` : `${command}: error TS6059`, stderr: '' };
  });
}
const passingValidation = validationExecutor();
/** Green baseline, typecheck broken after implementation: a regression. */
const failingValidation = validationExecutor({ post: { 'npm run typecheck': 2 } });
const postCalls = (exec: ReturnType<typeof validationExecutor>): unknown[][] => exec.mock.calls.filter((c) => c[2] === 'post');

/** A mission on its own fresh, allow-listed temporary Git repository. */
function createMission(repo = makeRepo()): string {
  allowRepo(repo);
  const id = uuidv4();
  getDatabase().prepare(`INSERT INTO missions (id, issue_text, repo_path, status) VALUES (?, ?, ?, 'created')`)
    .run(id, 'calculateDiscount returns negative prices for rate > 100', repo);
  return id;
}

const q = {
  mission: (id: string) => getDatabase().prepare('SELECT * FROM missions WHERE id = ?').get(id) as Record<string, unknown>,
  phases: (id: string) => getDatabase().prepare('SELECT phase_name, status, error_message FROM pipeline_phases WHERE mission_id = ? ORDER BY rowid').all(id) as Array<{ phase_name: string; status: string; error_message: string | null }>,
  tasks: (id: string) => getDatabase().prepare('SELECT task_type, status, error_message FROM agent_tasks WHERE mission_id = ?').all(id) as Array<{ task_type: string; status: string; error_message: string | null }>,
  evidence: (id: string) => getDatabase().prepare('SELECT evidence_type, phase_name, content FROM evidence WHERE mission_id = ?').all(id) as Array<{ evidence_type: string; phase_name: string; content: string }>,
};
const statusOf = (id: string, phase: string): string | undefined => q.phases(id).find((p) => p.phase_name === phase)?.status;
const eventsFor = (id: string): string[] => events.filter((e) => e.missionId === id).map((e) => e.type);

/** Run the orchestrator, auto-approving the plan when the gate is reached. */
async function runWithAutoApprove(orch: MissionOrchestrator, id: string): Promise<void> {
  const timer = setInterval(() => {
    const m = q.mission(id);
    if (m['status'] === 'awaiting_approval') getDatabase().prepare('UPDATE missions SET plan_approved = 1 WHERE id = ?').run(id);
  }, 5);
  try {
    await orch.run(id);
  } finally {
    clearInterval(timer);
  }
}

function orchestrator(bob: FakeBobClient, executeValidationCommand = passingValidation): MissionOrchestrator {
  return new MissionOrchestrator({
    bobClient: bob, executeValidationCommand,
    approvalPollIntervalMs: 5, approvalTimeoutMs: 5_000,
  });
}

beforeAll(() => { getDatabase(); });
afterAll(() => { cleanupRepos(); });
beforeEach(() => { events.length = 0; passingValidation.mockClear(); failingValidation.mockClear(); });

describe('successful pipeline', () => {
  it('completes every phase and the mission, with a verdict from the report + validation evidence', async () => {
    const id = createMission();
    const bob = new FakeBobClient();
    await runWithAutoApprove(orchestrator(bob), id);

    expect(q.phases(id).map((p) => `${p.phase_name}:${p.status}`)).toEqual([
      'repo_understanding:completed', 'parallel_analysis:completed', 'change_plan:completed',
      'implementation:completed', 'validation:completed', 'release_report:completed',
    ]);
    expect(q.mission(id)['status']).toBe('complete');
    const done = events.find((e) => e.type === 'mission.completed' && e.missionId === id);
    expect(done?.payload).toMatchObject({ releaseReadiness: 'ready', summary: 'All validation passed.' });
    expect(eventsFor(id)).toContain('agent.started');
    expect(eventsFor(id)).toContain('agent.completed');
    expect(eventsFor(id)).toContain('evidence.created');
    // agent.output is only forwarded from real parsed stream content; the fake never streams.
    expect(eventsFor(id)).not.toContain('agent.output');
  });
});

describe('failure propagation', () => {
  it('Phase 1 failure: phase failed, Phase 2 never runs, remaining phases blocked, mission failed', async () => {
    const id = createMission();
    const bob = new FakeBobClient({ repo_understander: 'fail' });
    await runWithAutoApprove(orchestrator(bob), id);

    expect(bob.calls).toEqual(['repo_understander']);
    expect(statusOf(id, 'repo_understanding')).toBe('failed');
    for (const p of ['parallel_analysis', 'change_plan', 'implementation', 'validation', 'release_report']) {
      expect(statusOf(id, p)).toBe('skipped');
    }
    expect(q.phases(id).some((p) => p.status === 'completed')).toBe(false);
    expect(q.tasks(id)).toEqual([expect.objectContaining({ task_type: 'repo_understander', status: 'failed' })]);

    const m = q.mission(id);
    expect(m['status']).toBe('failed');
    expect(m['error_message']).toMatch(/Phase "repo_understanding" failed: repo_understander \[bob_error\] .*Budget exceeded/);
    expect(m['release_report']).toBeNull();

    const err = q.evidence(id).find((e) => e.evidence_type === 'error');
    expect(err).toBeDefined();
    const diag = JSON.parse(err!.content) as Record<string, unknown>;
    expect(diag).toMatchObject({ success: false, errorKind: 'bob_error', exitCode: 1, durationMs: 7, stderr: 'Budget exceeded' });

    const types = eventsFor(id);
    expect(types).toContain('agent.failed');
    expect(types).toContain('phase.failed');
    expect(types).toContain('mission.failed');
    expect(types).not.toContain('mission.completed');
    expect(types).not.toContain('plan.ready');
  });

  it('Bob success without the required JSON block fails the phase (no manufactured summary)', async () => {
    const id = createMission();
    await runWithAutoApprove(orchestrator(new FakeBobClient({ repo_understander: 'no-json' })), id);
    expect(statusOf(id, 'repo_understanding')).toBe('failed');
    expect(q.mission(id)['error_message']).toMatch(/FORGEGUARD:JSON/);
  });

  it('one failed specialist fails Phase 2 and no change plan is synthesized', async () => {
    const id = createMission();
    const bob = new FakeBobClient({ security_analyst: 'fail' });
    await runWithAutoApprove(orchestrator(bob), id);

    expect(statusOf(id, 'parallel_analysis')).toBe('failed');
    expect(statusOf(id, 'change_plan')).toBe('skipped');
    expect(bob.calls).not.toContain('plan_synthesizer');
    expect(q.mission(id)['change_plan']).toBeNull();
    expect(q.mission(id)['error_message']).toMatch(/1 of 5 specialist tasks failed: security_analyst/);
    expect(q.tasks(id).filter((t) => t.status === 'completed')).toHaveLength(5); // phase 1 + 4 specialists
  });

  it('a malformed change plan fails Phase 3 and never reaches approval', async () => {
    const id = createMission();
    const bob = new FakeBobClient({}, true, { plan_synthesizer: json({ summary: 'no steps' }) });
    await runWithAutoApprove(orchestrator(bob), id);
    expect(statusOf(id, 'change_plan')).toBe('failed');
    expect(eventsFor(id)).not.toContain('plan.ready');
    expect(q.mission(id)['status']).toBe('failed');
  });

  it('implementation failure: validation never runs and nothing is reported as passed', async () => {
    const id = createMission();
    const bob = new FakeBobClient({ implementer: 'fail' });
    await runWithAutoApprove(orchestrator(bob), id);

    expect(statusOf(id, 'implementation')).toBe('failed');
    expect(statusOf(id, 'validation')).toBe('skipped');
    expect(postCalls(passingValidation)).toHaveLength(0); // only the baseline ran
    expect(q.mission(id)['validation_result']).toBeNull();
    expect(eventsFor(id)).not.toContain('mission.completed');
    expect(loadReleaseVerdict(getDatabase(), id)).toMatchObject({ verdict: 'blocked', implementationSucceeded: false });
  });

  it('validation regression: mission failed (blocked), release report not generated, never complete', async () => {
    const id = createMission();
    const bob = new FakeBobClient();
    await runWithAutoApprove(orchestrator(bob, failingValidation), id);

    expect(statusOf(id, 'validation')).toBe('failed');
    expect(statusOf(id, 'release_report')).toBe('skipped');
    expect(bob.calls).not.toContain('release_engineer');
    expect(q.mission(id)['status']).toBe('failed');
    expect(q.mission(id)['error_message']).toMatch(/Release blocked: "npm run typecheck" exited 2 .*\(regression\)/);
    expect(q.mission(id)['validation_result']).toContain('TS6059'); // evidence still persisted
    expect(eventsFor(id)).not.toContain('mission.completed');
  });
});

const runsOf = (id: string) => getDatabase().prepare(`
  SELECT v.*, p.phase_name FROM validation_runs v JOIN pipeline_phases p ON p.id = v.phase_id
  WHERE v.mission_id = ? ORDER BY v.rowid`).all(id) as Array<Record<string, unknown>>;

describe('baseline and post-implementation validation', () => {
  it('runs the same commands before and after implementation and persists both as rows', async () => {
    const id = createMission();
    await runWithAutoApprove(orchestrator(new FakeBobClient()), id);

    const runs = runsOf(id);
    const commands = ['npm run lint', 'npm test', 'npm run typecheck', 'npm run build'];
    expect(runs.filter((r) => r['run_kind'] === 'baseline').map((r) => r['command'])).toEqual(commands);
    expect(runs.filter((r) => r['run_kind'] === 'post').map((r) => r['command'])).toEqual(commands);
    for (const r of runs) {
      expect(r['phase_name']).toBe(r['run_kind'] === 'baseline' ? 'repo_understanding' : 'validation');
      expect(r).toMatchObject({ exit_code: 0, passed: 1, stderr: '' });
      expect(r['stdout']).toMatch(/: ok$/);
      expect(typeof r['duration_ms']).toBe('number');
      expect(r['started_at']).toBeTruthy();
      expect(r['completed_at']).toBeTruthy();
    }
    // The baseline completed before the implementer task started.
    const implementer = getDatabase().prepare(`SELECT started_at FROM agent_tasks WHERE mission_id = ? AND task_type = 'implementer'`).get(id) as { started_at: string };
    const lastBaseline = runs.filter((r) => r['run_kind'] === 'baseline').at(-1)!;
    expect(String(lastBaseline['completed_at']) <= implementer.started_at).toBe(true);
    expect(eventsFor(id).filter((t) => t === 'validation.completed')).toHaveLength(8);
  });

  it('a pre-existing failure is kept distinct: conditional verdict, not a regression', async () => {
    const id = createMission();
    const exec = validationExecutor({ baseline: { 'npm run typecheck': 2 }, post: { 'npm run typecheck': 2 } });
    await runWithAutoApprove(orchestrator(new FakeBobClient(), exec), id);

    expect(q.mission(id)['status']).toBe('complete');
    const done = events.find((e) => e.type === 'mission.completed' && e.missionId === id);
    expect(done?.payload).toMatchObject({ releaseReadiness: 'conditional' });
    const verdict = loadReleaseVerdict(getDatabase(), id);
    expect(verdict.verdict).toBe('conditional');
    expect(verdict.commands.find((c) => c.command === 'npm run typecheck')?.classification).toBe('preexisting_failure');
  });
});

describe('release verdict', () => {
  it('the verdict comes from validation rows; Bob agreeing records no discrepancy', async () => {
    const id = createMission();
    await runWithAutoApprove(orchestrator(new FakeBobClient()), id);

    expect(loadReleaseVerdict(getDatabase(), id).verdict).toBe('ready');
    const report = JSON.parse(String(q.mission(id)['release_report'])) as Record<string, unknown>;
    expect(report).toMatchObject({ verdict: 'ready', bobAssessment: 'ready', agreesWithVerdict: true, discrepancy: null });
    expect(report['bobNarrative']).toMatchObject({ summary: 'All validation passed.' });
  });

  it('Bob says "ready" while a pre-existing failure remains: the deterministic verdict wins', async () => {
    const id = createMission();
    const exec = validationExecutor({ baseline: { 'npm run lint': 1 }, post: { 'npm run lint': 1 } });
    await runWithAutoApprove(orchestrator(new FakeBobClient(), exec), id);

    const done = events.find((e) => e.type === 'mission.completed' && e.missionId === id);
    expect(done?.payload).toMatchObject({ releaseReadiness: 'conditional', bobAssessment: 'ready' });
    expect(String((done?.payload as { discrepancy: string }).discrepancy)).toMatch(/assessed "ready" .* is "conditional"/);
    expect(JSON.parse(String(q.mission(id)['release_report']))).toMatchObject({ verdict: 'conditional', agreesWithVerdict: false });
  });

  it('Bob says "blocked" while validation is green: mission follows the evidence, discrepancy preserved as evidence', async () => {
    const id = createMission();
    const bob = new FakeBobClient({}, true, { release_engineer: json({ releaseReadiness: 'blocked', summary: 'I would hold this.' }) });
    await runWithAutoApprove(orchestrator(bob), id);

    expect(q.mission(id)['status']).toBe('complete');
    const done = events.find((e) => e.type === 'mission.completed' && e.missionId === id);
    expect(done?.payload).toMatchObject({ releaseReadiness: 'ready', bobAssessment: 'blocked' });
    const discrepancy = q.evidence(id).find((e) => e.phase_name === 'release_report' && e.content.startsWith('Verdict discrepancy'));
    expect(discrepancy?.content).toMatch(/assessed "blocked" but the deterministic verdict .* is "ready"/);
  });

  it('a report without releaseReadiness fails the mission — no default verdict is emitted', async () => {
    const id = createMission();
    const bob = new FakeBobClient({}, true, { release_engineer: json({ summary: 'looks fine' }) });
    await runWithAutoApprove(orchestrator(bob), id);

    expect(statusOf(id, 'release_report')).toBe('failed');
    expect(q.mission(id)['status']).toBe('failed');
    expect(events.some((e) => e.missionId === id && e.type === 'mission.completed')).toBe(false);
    expect(JSON.stringify(events.filter((e) => e.missionId === id))).not.toContain('"conditional"');
  });

  it('a mission that never ran validation has no verdict', () => {
    const id = createMission();
    expect(loadReleaseVerdict(getDatabase(), id)).toMatchObject({ verdict: null });
  });
});

describe('startMission preflight', () => {
  it('Bob unavailable: 503 BOB_UNAVAILABLE, no phases, no agent tasks, mission failed with diagnostic evidence', async () => {
    const id = createMission();
    const bob = new FakeBobClient({}, false);
    const r = await startMission(id, { bobClient: bob });

    expect(r.httpStatus).toBe(503);
    expect(r.body['code']).toBe('BOB_UNAVAILABLE');
    expect(bob.calls).toHaveLength(0);
    expect(q.phases(id)).toHaveLength(0);
    expect(q.tasks(id)).toHaveLength(0);
    expect(q.mission(id)).toMatchObject({ status: 'failed' });
    expect(String(q.mission(id)['error_message'])).toMatch(/^BOB_UNAVAILABLE: Bob Shell CLI not found/);
    expect(q.evidence(id)).toEqual([expect.objectContaining({ evidence_type: 'error', phase_name: 'preflight' })]);
    expect(eventsFor(id)).toContain('mission.failed');
    expect(eventsFor(id)).not.toContain('phase.started');
  });

  it('rejects a start while the mission is in progress', async () => {
    const id = createMission();
    getDatabase().prepare(`UPDATE missions SET status = 'awaiting_approval' WHERE id = ?`).run(id);
    const r = await startMission(id, { bobClient: new FakeBobClient() });
    expect(r.httpStatus).toBe(409);
  });

  it('a re-run resets the previous approval so the new plan must be approved again', async () => {
    const id = createMission();
    getDatabase().prepare(`UPDATE missions SET status = 'failed', plan_approved = 1 WHERE id = ?`).run(id);
    const bob = new FakeBobClient();
    const r = await startMission(id, {
      bobClient: bob, executeValidationCommand: passingValidation,
      approvalPollIntervalMs: 5, approvalTimeoutMs: 300,
    });
    expect(r.httpStatus).toBe(202);
    expect(q.mission(id)['plan_approved']).toBe(0);
    await vi.waitFor(() => expect(q.mission(id)['status']).toBe('failed'), { timeout: 3_000 });
    expect(q.mission(id)['error_message']).toMatch(/approval timed out/);
    expect(bob.calls).not.toContain('implementer');
    expect(statusOf(id, 'implementation')).toBe('skipped');
  });
});

describe('secret redaction in evidence', () => {
  it('never stores the Bob API key in tasks or evidence', async () => {
    const id = createMission();
    await runWithAutoApprove(orchestrator(new FakeBobClient({ repo_understander: 'leak' })), id);
    const stored = JSON.stringify([q.evidence(id), getDatabase().prepare('SELECT * FROM agent_tasks WHERE mission_id = ?').all(id), q.mission(id)]);
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain('[REDACTED]');
  });
});

// ─── Milestone 5: rollback anchor, repository lock, validation timeout ─────────

const evidenceOf = (id: string, event: string): Record<string, unknown> | undefined => {
  const row = q.evidence(id).find((e) => e.content.includes(`"event": "${event}"`));
  return row ? JSON.parse(row.content) as Record<string, unknown> : undefined;
};

const read = (repo: string, rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf-8');

/** Run until the mission waits for approval, without approving. */
async function runUntilApproval(orch: MissionOrchestrator, id: string): Promise<{ done: Promise<void> }> {
  const done = orch.run(id);
  await vi.waitFor(() => expect(q.mission(id)['status']).toBe('awaiting_approval'), { timeout: 20_000, interval: 20 });
  return { done };
}

describe('rollback anchor in the pipeline', () => {
  it('anchors before Bob implements; rollback restores the exact pre-implementation state including developer WIP', async () => {
    const repo = makeRepo();
    write(repo, 'src/a.ts', 'developer WIP\n');
    write(repo, 'scratch.txt', 'untracked developer notes\n');
    const before = repoState(repo);
    const bob = new SharedFakeBob({
      onImplement: (ws) => {
        write(ws, 'src/a.ts', 'bob changed WIP file\n');
        write(ws, 'src/generated/new.ts', 'bob new file\n');
        fs.rmSync(path.join(ws, 'src/b.ts'));
      },
    });
    const id = createMission(repo);
    await runWithAutoApprove(orchestrator(bob), id);

    expect(q.mission(id)['status']).toBe('complete');
    const ref = String(q.mission(id)['rollback_ref']);
    expect(ref).toMatch(new RegExp(`^refs/forgeguard/anchors/${id}/[0-9a-f]{8}$`));
    const created = evidenceOf(id, 'rollback_anchor_created')!;
    expect(created).toMatchObject({ ref, head: before.head, branch: 'refs/heads/main', repository: repo });
    const implementer = getDatabase().prepare(`SELECT started_at FROM agent_tasks WHERE mission_id = ? AND task_type = 'implementer'`).get(id) as { started_at: string };
    expect(String(created['createdAt']) <= implementer.started_at).toBe(true);
    expect(evidenceOf(id, 'result_snapshot_recorded')).toBeDefined();
    expect(fs.existsSync(path.join(repo, '.git', 'forgeguard.lock'))).toBe(false); // lock released

    const r = await rollbackMission(id);
    expect(r.httpStatus).toBe(200);
    expect(repoState(repo)).toEqual(before);
    expect(read(repo, 'src/a.ts')).toBe('developer WIP\n');
    expect(q.mission(id)['status']).toBe('rolled_back');
  });

  it('12: no valid anchor (repository without commits) → implementation refused, Bob never implements', async () => {
    const repo = makeRepo(undefined, false);
    const bob = new FakeBobClient();
    const id = createMission(repo);
    await runWithAutoApprove(orchestrator(bob), id);

    expect(bob.calls).not.toContain('implementer');
    expect(statusOf(id, 'implementation')).toBe('failed');
    expect(statusOf(id, 'validation')).toBe('skipped');
    expect(q.mission(id)).toMatchObject({ status: 'failed', rollback_ref: null });
    expect(String(q.mission(id)['error_message'])).toMatch(/Rollback anchor could not be created, implementation not started: NO_COMMITS/);
    expect(evidenceOf(id, 'rollback_anchor_failed')).toMatchObject({ code: 'NO_COMMITS' });
  });

  it('not a Git repository → the mission fails before any repository work, with evidence', async () => {
    const dir = makeDir();
    const bob = new FakeBobClient();
    const id = createMission(dir);
    await runWithAutoApprove(orchestrator(bob), id);
    expect(bob.calls).toEqual([]);
    expect(String(q.mission(id)['error_message'])).toMatch(/REPO_NOT_GIT/);
    expect(evidenceOf(id, 'repo_lock_failed')).toMatchObject({ code: 'REPO_NOT_GIT' });

    const id2 = createMission(dir);
    const r = await startMission(id2, { bobClient: new FakeBobClient() });
    expect(r).toMatchObject({ httpStatus: 422, body: { code: 'REPO_NOT_GIT' } });
    expect(q.mission(id2)['status']).toBe('failed');
    expect(q.phases(id2)).toHaveLength(0);
  });

  it('a working-tree change between baseline and implementation refuses implementation (baseline would be stale)', async () => {
    const repo = makeRepo();
    const bob = new FakeBobClient();
    const id = createMission(repo);
    const { done } = await runUntilApproval(orchestrator(bob), id);
    write(repo, 'src/a.ts', 'edited while the plan was awaiting approval\n');
    getDatabase().prepare('UPDATE missions SET plan_approved = 1 WHERE id = ?').run(id);
    await done;

    expect(bob.calls).not.toContain('implementer');
    expect(String(q.mission(id)['error_message'])).toMatch(/REPO_CHANGED_SINCE_BASELINE/);
    expect(q.mission(id)['rollback_ref']).toBeNull();
    expect(gitSync(repo, ['for-each-ref', 'refs/forgeguard/'])).toBe(''); // the unused anchor was deleted
  });

  it('13: two missions cannot implement against the same repository concurrently', async () => {
    const repo = makeRepo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let aImplementing!: () => void;
    const aStarted = new Promise<void>((r) => { aImplementing = r; });
    const bobA = new SharedFakeBob({ onImplement: async (ws) => { aImplementing(); await gate; write(ws, 'a.ts', 'A\n'); } });
    const bobB = new FakeBobClient();
    const a = createMission(repo);
    const b = createMission(repo);

    const { done: bDone } = await runUntilApproval(orchestrator(bobB), b); // B has its baseline and waits for approval
    const aDone = runWithAutoApprove(orchestrator(bobA), a);
    await aStarted;                                               // A holds the lock and is implementing

    const c = createMission(repo);
    expect(await startMission(c, { bobClient: new FakeBobClient() }))
      .toMatchObject({ httpStatus: 409, body: { code: 'REPO_LOCKED', lockedBy: a } });

    getDatabase().prepare('UPDATE missions SET plan_approved = 1 WHERE id = ?').run(b);
    await bDone;
    expect(bobB.calls).not.toContain('implementer');
    expect(q.mission(b)).toMatchObject({ status: 'failed', rollback_ref: null });
    expect(String(q.mission(b)['error_message'])).toMatch(/Implementation not started: REPO_LOCKED: Repository is locked by mission/);

    release();
    await aDone;
    expect(q.mission(a)['status']).toBe('complete');
    expect(read(repo, 'a.ts')).toBe('A\n');
  });

  it('startMission refuses a re-run while an anchor has not been rolled back, and a disallowed repository', async () => {
    const repo = makeRepo();
    const id = createMission(repo);
    await runWithAutoApprove(orchestrator(new FakeBobClient()), id);
    expect(await startMission(id, { bobClient: new FakeBobClient() })).toMatchObject({ httpStatus: 409, body: { code: 'ROLLBACK_PENDING' } });

    const outside = makeRepo();
    const bad = uuidv4();
    getDatabase().prepare(`INSERT INTO missions (id, issue_text, repo_path, status) VALUES (?, 'x', ?, 'created')`).run(bad, outside);
    const r = await startMission(bad, { bobClient: new FakeBobClient() });
    expect(r).toMatchObject({ httpStatus: 403, body: { code: 'REPO_NOT_ALLOWED' } });
    expect(JSON.stringify(r.body)).not.toContain(outside);
    expect(q.mission(bad)['status']).toBe('failed');
    expect(q.evidence(bad)).toEqual([expect.objectContaining({ evidence_type: 'error', phase_name: 'preflight' })]);
  });
});

describe('validation timeout in the pipeline', () => {
  it('a post-implementation timeout fails Phase 5, blocks the release, and keeps partial output as evidence', async () => {
    const exec = vi.fn(async (command: string, _cwd: string, kind: RunKind, timeoutMs: number): Promise<CommandExecution> =>
      kind === 'post' && command === 'npm test'
        ? { exitCode: null, timedOut: true, stdout: `partial stdout before kill (${timeoutMs})`, stderr: 'partial stderr' }
        : { exitCode: 0, timedOut: false, stdout: 'ok', stderr: '' });
    const id = createMission();
    await runWithAutoApprove(new MissionOrchestrator({
      bobClient: new FakeBobClient(), executeValidationCommand: exec, validationTimeoutMs: 1234,
      approvalPollIntervalMs: 5, approvalTimeoutMs: 5_000,
    }), id);

    expect(statusOf(id, 'validation')).toBe('failed');
    expect(statusOf(id, 'release_report')).toBe('skipped');
    expect(String(q.mission(id)['error_message'])).toMatch(/Release blocked: "npm test" timed out after implementation/);
    const row = getDatabase().prepare(`SELECT * FROM validation_runs WHERE mission_id = ? AND run_kind = 'post' AND command = 'npm test'`).get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ timed_out: 1, exit_code: null, passed: 0, stdout: 'partial stdout before kill (1234)', stderr: 'partial stderr' });
    expect(loadReleaseVerdict(getDatabase(), id).verdict).toBe('blocked');
    expect(evidenceOf(id, 'validation_timeout')).toMatchObject({
      code: 'VALIDATION_TIMEOUT', command: 'npm test', kind: 'post', timeoutMs: 1234, stdout: 'partial stdout before kill (1234)',
    });
  });
});
