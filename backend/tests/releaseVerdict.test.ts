/**
 * Deterministic release verdict — unit tests over fake validation_runs rows (no Bob, no DB).
 */
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_VALIDATION_COMMANDS,
  computeReleaseVerdict,
  reconcileBobAssessment,
  type RunKind,
  type ValidationRunRow,
} from '../src/pipeline/releaseVerdict';

const LINT = 'npm run lint';
const TEST = 'npm test';
const TYPECHECK = 'npm run typecheck';
const BUILD = 'npm run build';

let seq = 0;
function row(kind: RunKind, command: string, exitCode: number): ValidationRunRow {
  seq += 1;
  return {
    id: `${kind}-${seq}`, run_kind: kind, command,
    exit_code: exitCode, passed: exitCode === 0 ? 1 : 0, completed_at: '2026-09-26T12:00:00.000Z',
  };
}

/** One row per required command; `failing` maps command → exit code. */
function suite(kind: RunKind, failing: Record<string, number> = {}): ValidationRunRow[] {
  return REQUIRED_VALIDATION_COMMANDS.map((c) => row(kind, c, failing[c] ?? 0));
}

const classOf = (r: ReturnType<typeof computeReleaseVerdict>, command: string): string | undefined =>
  r.commands.find((c) => c.command === command)?.classification;

describe('computeReleaseVerdict', () => {
  it('1. baseline all green + post all green → ready', () => {
    const r = computeReleaseVerdict({ baseline: suite('baseline'), post: suite('post'), implementationSucceeded: true });
    expect(r.verdict).toBe('ready');
    expect(r.commands.map((c) => c.classification)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(r.commands.every((c) => c.baselineRunId && c.postRunId)).toBe(true);
  });

  it('2. a baseline failure that remains unchanged is a pre-existing failure, not a regression', () => {
    const r = computeReleaseVerdict({
      baseline: suite('baseline', { [TYPECHECK]: 2 }),
      post: suite('post', { [TYPECHECK]: 2 }),
      implementationSucceeded: true,
    });
    expect(classOf(r, TYPECHECK)).toBe('preexisting_failure');
    expect(r.commands.some((c) => c.classification === 'regression')).toBe(false);
    // Not ignored either: it keeps the release from being "ready".
    expect(r.verdict).toBe('conditional');
    expect(r.reasons.join('\n')).toMatch(/"npm run typecheck" failed before and after implementation .*not a regression/);
  });

  it('3. baseline green + post failure → regression → blocked', () => {
    const r = computeReleaseVerdict({
      baseline: suite('baseline'),
      post: suite('post', { [LINT]: 1 }),
      implementationSucceeded: true,
    });
    expect(classOf(r, LINT)).toBe('regression');
    expect(r.verdict).toBe('blocked');
    expect(r.reasons).toEqual(['"npm run lint" exited 1 after implementation but passed in the baseline (regression)']);
  });

  it('4. a missing post-validation result → cannot claim ready', () => {
    const r = computeReleaseVerdict({
      baseline: suite('baseline'),
      post: suite('post').filter((x) => x.command !== TYPECHECK),
      implementationSucceeded: true,
    });
    expect(classOf(r, TYPECHECK)).toBe('missing_post');
    expect(r.verdict).toBe('blocked');
    expect(r.reasons.join()).toMatch(/"npm run typecheck" has no post-implementation result/);
  });

  it('5. a missing baseline result → a failure cannot be classified as pre-existing', () => {
    const baseline = suite('baseline').filter((x) => x.command !== TEST);
    const failing = computeReleaseVerdict({ baseline, post: suite('post', { [TEST]: 1 }), implementationSucceeded: true });
    expect(classOf(failing, TEST)).toBe('unclassified_failure');
    expect(failing.verdict).toBe('blocked');

    // Even when the command passes, missing baseline evidence prevents "ready".
    const passing = computeReleaseVerdict({ baseline, post: suite('post'), implementationSucceeded: true });
    expect(classOf(passing, TEST)).toBe('pass_without_baseline');
    expect(passing.verdict).toBe('conditional');
  });

  it('8. zero validation runs → no release verdict', () => {
    const r = computeReleaseVerdict({ baseline: [], post: [], implementationSucceeded: true });
    expect(r.verdict).toBeNull();
    expect(r.reasons.join()).toMatch(/No validation runs recorded/);
  });

  it('9. malformed validation data → no release verdict', () => {
    const cases: Array<[string, Partial<ValidationRunRow>]> = [
      ['unfinished run', { completed_at: null, exit_code: null, passed: null }],
      ['passed contradicts exit code', { exit_code: 2, passed: 1 }],
      ['non-integer exit code', { exit_code: 'zero' }],
      ['invalid passed value', { passed: 'yes' }],
      ['wrong run_kind', { run_kind: 'baseline' }],
      ['missing command', { command: '' }],
    ];
    for (const [name, patch] of cases) {
      const post = suite('post');
      post[1] = { ...post[1], ...patch };
      const r = computeReleaseVerdict({ baseline: suite('baseline'), post, implementationSucceeded: true });
      expect(r.verdict, name).toBeNull();
      expect(r.reasons[0], name).toMatch(/^Malformed validation data/);
    }

    const duplicated = computeReleaseVerdict({
      baseline: suite('baseline'), post: [...suite('post'), row('post', LINT, 1)], implementationSucceeded: true,
    });
    expect(duplicated.verdict).toBeNull();
    expect(duplicated.reasons.join()).toMatch(/duplicate post result/);
  });

  it('10. failed implementation → the release decision cannot be ready', () => {
    const r = computeReleaseVerdict({ baseline: suite('baseline'), post: suite('post'), implementationSucceeded: false });
    expect(r.verdict).toBe('blocked');
    expect(r.reasons.join()).toMatch(/Implementation did not succeed/);
    expect(computeReleaseVerdict({ baseline: [], post: [], implementationSucceeded: false }).verdict).toBe('blocked');
  });

  it('a baseline failure fixed by the implementation counts as passing', () => {
    const r = computeReleaseVerdict({
      baseline: suite('baseline', { [BUILD]: 2 }), post: suite('post'), implementationSucceeded: true,
    });
    expect(classOf(r, BUILD)).toBe('fixed');
    expect(r.verdict).toBe('ready');
  });

  it('a regression blocks even when other failures are pre-existing', () => {
    const r = computeReleaseVerdict({
      baseline: suite('baseline', { [TYPECHECK]: 2 }),
      post: suite('post', { [TYPECHECK]: 2, [TEST]: 1 }),
      implementationSucceeded: true,
    });
    expect(classOf(r, TYPECHECK)).toBe('preexisting_failure');
    expect(classOf(r, TEST)).toBe('regression');
    expect(r.verdict).toBe('blocked');
  });

  it('a post-implementation timeout blocks; a timed-out baseline counts as missing baseline evidence', () => {
    const timedOut = (kind: RunKind, command: string): ValidationRunRow => ({ ...row(kind, command, 0), exit_code: null, passed: 0, timed_out: 1 });

    const post = suite('post').map((r) => (r.command === TEST ? timedOut('post', TEST) : r));
    const blocked = computeReleaseVerdict({ baseline: suite('baseline'), post, implementationSucceeded: true });
    expect(blocked.verdict).toBe('blocked');
    expect(classOf(blocked, TEST)).toBe('timed_out');
    expect(blocked.commands.find((c) => c.command === TEST)).toMatchObject({ post: 'timed_out', postExitCode: null });
    expect(blocked.reasons.join()).toMatch(/"npm test" timed out after implementation/);

    const baseline = suite('baseline').map((r) => (r.command === TEST ? timedOut('baseline', TEST) : r));
    const cond = computeReleaseVerdict({ baseline, post: suite('post'), implementationSucceeded: true });
    expect(classOf(cond, TEST)).toBe('pass_without_baseline');
    expect(cond.verdict).toBe('conditional');
    expect(cond.reasons.join()).toMatch(/its baseline run timed out/);
    const failing = computeReleaseVerdict({ baseline, post: suite('post', { [TEST]: 1 }), implementationSucceeded: true });
    expect(classOf(failing, TEST)).toBe('unclassified_failure');

    const contradictory = suite('post').map((r) => (r.command === TEST ? { ...r, timed_out: 1 } : r)); // exit 0 + timed out
    expect(computeReleaseVerdict({ baseline: suite('baseline'), post: contradictory, implementationSucceeded: true }).verdict).toBeNull();
  });

  it('an unknown implementation outcome prevents ready', () => {
    const r = computeReleaseVerdict({ baseline: suite('baseline'), post: suite('post'), implementationSucceeded: null });
    expect(r.verdict).toBe('conditional');
  });
});

describe('reconcileBobAssessment (Bob is narrative, the verdict is authoritative)', () => {
  it('6. Bob says ready but validation fails → validation wins', () => {
    const v = computeReleaseVerdict({ baseline: suite('baseline'), post: suite('post', { [LINT]: 1 }), implementationSucceeded: true });
    expect(v.verdict).toBe('blocked');
    const r = reconcileBobAssessment(v.verdict!, 'ready');
    expect(r).toMatchObject({ bobAssessment: 'ready', agreesWithVerdict: false });
    expect(r.discrepancy).toMatch(/Bob's narrative assessed "ready" but the deterministic verdict .* is "blocked"/);
  });

  it('7. Bob says blocked but validation is green → the discrepancy is preserved, verdict stays ready', () => {
    const v = computeReleaseVerdict({ baseline: suite('baseline'), post: suite('post'), implementationSucceeded: true });
    expect(v.verdict).toBe('ready');
    const r = reconcileBobAssessment(v.verdict!, 'blocked');
    expect(r).toMatchObject({ bobAssessment: 'blocked', agreesWithVerdict: false });
    expect(r.discrepancy).toMatch(/assessed "blocked" .* is "ready"; the deterministic verdict is used/);
  });

  it('agreement records no discrepancy; legacy "not-ready" maps to blocked; junk is flagged', () => {
    expect(reconcileBobAssessment('ready', 'ready')).toEqual({ bobAssessment: 'ready', agreesWithVerdict: true, discrepancy: null });
    expect(reconcileBobAssessment('blocked', 'not-ready').agreesWithVerdict).toBe(true);
    const junk = reconcileBobAssessment('conditional', 'ship it');
    expect(junk.bobAssessment).toBeNull();
    expect(junk.discrepancy).toMatch(/no recognised releaseReadiness/);
  });
});
