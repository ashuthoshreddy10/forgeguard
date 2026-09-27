import { describe, expect, it } from 'vitest';
import {
  blockedBy, bobUnavailableInfo, classifyError, currentRunValidation, failureDetails, latestPhases,
  parseReleaseReport, redactPaths, stripAnsi,
} from './selectors';
import { evidence, mission, phase, run, task } from '../test/fixtures';

describe('latestPhases', () => {
  it('3. picks the newest row per phase after a re-run, not the first', () => {
    const oldFailed = phase('repo_understanding', 'failed', { error_message: 'old failure' });
    const oldSkipped = phase('parallel_analysis', 'skipped');
    const newDone = phase('repo_understanding', 'completed');
    const newRunning = phase('parallel_analysis', 'running');
    const latest = latestPhases([oldFailed, oldSkipped, newDone, newRunning]);
    expect(latest['repo_understanding']?.id).toBe(newDone.id);
    expect(latest['parallel_analysis']?.id).toBe(newRunning.id);
  });

  it('uses backend seq, not array order, when present', () => {
    const newer = { ...phase('validation', 'completed'), seq: 99 };
    const older = { ...phase('validation', 'failed'), seq: 5 };
    expect(latestPhases([newer, older])['validation']?.status).toBe('completed');
  });
});

describe('blockedBy', () => {
  it('names the failed prerequisite of a skipped phase', () => {
    expect(blockedBy(phase('validation', 'skipped', { error_message: 'Blocked: phase "implementation" failed' }))).toBe('implementation');
    expect(blockedBy(phase('validation', 'completed'))).toBeNull();
  });
});

describe('classifyError', () => {
  it('uses the codes and error kinds the backend writes', () => {
    expect(classifyError('BOB_UNAVAILABLE: Bob Shell CLI not found on PATH.')).toMatchObject({ code: 'BOB_UNAVAILABLE' });
    expect(classifyError('Phase "implementation" failed: Implementation not started: REPO_LOCKED: Repository is locked'))
      .toMatchObject({ code: 'REPO_LOCKED', reason: 'Implementation not started: REPO_LOCKED: Repository is locked' });
    expect(classifyError('Phase "repo_understanding" failed: repo_understander [bob_error] Bob reported an error: Budget exceeded'))
      .toMatchObject({ code: 'BOB_TASK_FAILED', kind: 'bob_error' });
    expect(classifyError('Phase "validation" failed: Release blocked: "npm test" exited 1 after implementation but passed in the baseline (regression)'))
      .toMatchObject({ code: 'RELEASE_BLOCKED' });
  });

  it('never displays full filesystem paths', () => {
    expect(redactPaths('cannot open C:\\Users\\dev\\secret\\repo\\file.ts now')).toBe('cannot open …/file.ts now');
    expect(redactPaths('at /home/dev/work/repo/src/a.ts')).toBe('at …/a.ts');
    expect(redactPaths('see http://localhost:5173/x')).toBe('see http://localhost:5173/x');
  });
});

describe('stripAnsi', () => {
  it('removes terminal colour codes from displayed output only', () => {
    expect(stripAnsi('\u001b[32m✓\u001b[39m tests/pricing.test.ts \u001b[2m(8 tests)\u001b[22m')).toBe('✓ tests/pricing.test.ts (8 tests)');
    expect(stripAnsi('plain')).toBe('plain');
  });
});

describe('failureDetails', () => {
  it('1. reports phase, task, classification and time of a failure', () => {
    const p1 = phase('repo_understanding', 'failed', { error_message: 'repo_understander [timeout] Bob task timed out', completed_at: '2026-09-26T10:01:00.000Z' });
    const t = task('repo_understander', p1.id, 'timed_out', { error_message: 'Bob task timed out' });
    const f = failureDetails(mission({ status: 'failed', error_message: 'Phase "repo_understanding" failed: repo_understander [timeout] Bob task timed out' }),
      latestPhases([p1]), [t]);
    expect(f).toMatchObject({ phase: 'repo_understanding', taskType: 'repo_understander', taskId: t.id, taskStatus: 'timed_out', timestamp: '2026-09-26T10:01:00.000Z' });
    expect(f?.classification).toMatchObject({ code: 'BOB_TASK_FAILED', kind: 'timeout' });
  });

  it('returns null for a healthy mission', () => {
    expect(failureDetails(mission({ status: 'complete' }), latestPhases([phase('validation', 'completed')]), [])).toBeNull();
  });
});

describe('bobUnavailableInfo', () => {
  it('4. is rebuilt from persisted preflight evidence and drops unsafe fields', () => {
    const diag = { provider: 'shell', available: false, code: 'BOB_UNAVAILABLE', error: 'Bob Shell CLI not found on PATH.', command: 'C:\\Program Files\\nodejs\\node.exe', entryPoint: 'C:\\x\\bob.js', resolvedVia: 'PATH' };
    const info = bobUnavailableInfo(mission({ status: 'failed', error_message: 'BOB_UNAVAILABLE: Bob Shell CLI not found on PATH.' }),
      [evidence('error', 'preflight', JSON.stringify(diag))], undefined);
    expect(info?.diagnostics).toEqual({ provider: 'shell', available: false, code: 'BOB_UNAVAILABLE', error: 'Bob Shell CLI not found on PATH.' });
    expect(JSON.stringify(info)).not.toContain('node.exe');
  });

  it('is null for other failures', () => {
    expect(bobUnavailableInfo(mission({ status: 'failed', error_message: 'REPO_NOT_GIT: Target is not a Git repository' }), [], undefined)).toBeNull();
  });
});

describe('currentRunValidation', () => {
  it('5. separates baseline and post rows of the current run and counts older attempts', () => {
    const oldP1 = phase('repo_understanding', 'failed');
    const p1 = phase('repo_understanding', 'completed');
    const p5 = phase('validation', 'completed');
    const runs = [
      run('baseline', 'npm test', oldP1.id, 0),
      run('baseline', 'npm test', p1.id, 0),
      run('post', 'npm test', p5.id, 1),
    ];
    const r = currentRunValidation(runs, latestPhases([oldP1, p1, p5]));
    expect(r.baseline.map((x) => x.phase_id)).toEqual([p1.id]);
    expect(r.post.map((x) => x.run_kind)).toEqual(['post']);
    expect(r.earlierRuns).toBe(1);
  });
});

describe('parseReleaseReport', () => {
  it('10. keeps Bob\'s assessment separate from the recorded deterministic verdict', () => {
    const n = parseReleaseReport(JSON.stringify({
      verdict: 'conditional', bobAssessment: 'ready', agreesWithVerdict: false,
      discrepancy: 'Bob\'s narrative assessed "ready" but the deterministic verdict from validation evidence is "conditional"',
      bobNarrative: { releaseReadiness: 'ready', summary: 'Looks good', remainingRisks: ['none'] },
    }));
    expect(n).toMatchObject({ bobAssessment: 'ready', recordedVerdict: 'conditional', agreesWithVerdict: false, summary: 'Looks good' });
    expect(parseReleaseReport('not json')).toBeNull();
    expect(parseReleaseReport(null)).toBeNull();
  });
});
