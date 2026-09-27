/**
 * Rollback matrix — real git in temporary repositories. "Bob's" edits are plain file
 * operations performed by the test between anchor creation and the result snapshot,
 * which is exactly where the orchestrator runs the implementer.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Real git on Windows costs ~50-80 ms per process; anchor + rollback run a few dozen.
vi.setConfig({ testTimeout: 30_000 });
import { v4 as uuidv4 } from 'uuid';

vi.mock('../src/ws/EventBus', () => ({ emitEvent: () => undefined }));
process.env['DB_PATH'] = ':memory:';

import { getDatabase } from '../src/db/database';
import { createAnchor, recordResultSnapshot, type Anchor } from '../src/git/snapshot';
import { rollbackMission } from '../src/pipeline/rollback';
import { allowRepo, cleanupRepos, gitSync, makeRepo, repoState, write } from './helpers/gitRepo';

beforeAll(() => { getDatabase(); });
afterAll(() => { cleanupRepos(); });

const db = () => getDatabase();
const rm = (repo: string, rel: string): void => fs.rmSync(path.join(repo, rel));
const read = (repo: string, rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf-8');

/** What the orchestrator does around the implementer: anchor → (Bob) → result snapshot → terminal status. */
async function runMission(repo: string, bob: (repo: string) => void, status = 'complete'): Promise<{ id: string; anchor: Anchor }> {
  allowRepo(repo);
  const id = uuidv4();
  db().prepare(`INSERT INTO missions (id, issue_text, repo_path, status) VALUES (?, 'x', ?, 'implementing')`).run(id, repo);
  const anchor = await createAnchor(repo, id);
  db().prepare('UPDATE missions SET rollback_ref = ? WHERE id = ?').run(anchor.ref, id);
  bob(repo);
  await recordResultSnapshot(anchor, id);
  db().prepare('UPDATE missions SET status = ? WHERE id = ?').run(status, id);
  return { id, anchor };
}

const statusOf = (id: string): string => (db().prepare('SELECT status FROM missions WHERE id = ?').get(id) as { status: string }).status;

describe.concurrent('rollback anchor', () => {
  it('creating an anchor does not modify the working tree, the index or the stash', async () => {
    const repo = makeRepo();
    write(repo, 'src/a.ts', 'dev edit\n');
    gitSync(repo, ['add', 'src/a.ts']);
    write(repo, 'src/b.ts', 'unstaged\n');
    write(repo, 'notes.txt', 'untracked\n');
    const before = repoState(repo);
    const anchor = await createAnchor(repo, uuidv4());
    expect(repoState(repo)).toEqual(before);
    expect(gitSync(repo, ['stash', 'list'])).toBe('');
    expect(anchor.ref).toMatch(/^refs\/forgeguard\/anchors\/[0-9a-f-]{36}\/[0-9a-f]{8}$/);
    expect(anchor.head).toBe(before.head);
    // The anchor holds the untracked file and the unstaged content.
    expect(gitSync(repo, ['show', `${anchor.commit}:notes.txt`])).toBe('untracked\n');
    expect(gitSync(repo, ['show', `${anchor.commit}:src/b.ts`])).toBe('unstaged\n');
  });

  it('each mission gets its own unique reference', async () => {
    const repo = makeRepo();
    const a = await createAnchor(repo, 'mission-a');
    const b = await createAnchor(repo, 'mission-b');
    const a2 = await createAnchor(repo, 'mission-a');
    expect(new Set([a.ref, b.ref, a2.ref]).size).toBe(3);
    expect(a.ref.startsWith('refs/forgeguard/anchors/mission-a/')).toBe(true);
  });
});

describe.concurrent('rollback matrix', () => {
  it('1 + 6/7/8: clean repository; Bob creates, modifies and deletes files → exact pre-implementation state', async () => {
    const repo = makeRepo();
    const before = repoState(repo);
    const { id } = await runMission(repo, (r) => {
      write(r, 'src/new/deep/file.ts', 'created by bob\n');
      write(r, 'src/a.ts', 'modified by bob\n');
      rm(r, 'src/c.ts');
    });
    const res = await rollbackMission(id);
    expect(res.httpStatus).toBe(200);
    expect(res.body['removed']).toEqual(['src/new/deep/file.ts']);
    expect(repoState(repo)).toEqual(before);
    expect(fs.existsSync(path.join(repo, 'src/new'))).toBe(false); // emptied directories removed
    expect(statusOf(id)).toBe('rolled_back');
  });

  it('2 + 9 + 11: dirty tracked file; Bob edits the same file → developer version survives, still unstaged', async () => {
    const repo = makeRepo();
    write(repo, 'src/a.ts', 'export const a = 42; // developer WIP\n');
    const before = repoState(repo);
    expect(before.status).toContain(' M src/a.ts');
    const { id } = await runMission(repo, (r) => {
      write(r, 'src/a.ts', 'bob rewrote this\n');
      write(r, 'src/extra.ts', 'bob\n');
    });
    expect((await rollbackMission(id)).httpStatus).toBe(200);
    expect(read(repo, 'src/a.ts')).toBe('export const a = 42; // developer WIP\n');
    expect(repoState(repo)).toEqual(before);
  });

  it('3: staged changes (including a partially staged file) keep their exact index state', async () => {
    const repo = makeRepo();
    write(repo, 'src/b.ts', 'staged version\n');
    gitSync(repo, ['add', 'src/b.ts']);
    write(repo, 'src/b.ts', 'staged version\nplus an unstaged line\n');
    write(repo, 'src/staged-new.ts', 'new and staged\n');
    gitSync(repo, ['add', 'src/staged-new.ts']);
    const before = repoState(repo);
    expect(before.status).toContain('MM src/b.ts');
    expect(before.status).toContain('A  src/staged-new.ts');
    const { id } = await runMission(repo, (r) => {
      write(r, 'src/b.ts', 'bob\n');
      gitSync(r, ['add', '-A']); // Bob even stages everything
      rm(r, 'src/staged-new.ts');
    });
    expect((await rollbackMission(id)).httpStatus).toBe(200);
    expect(repoState(repo)).toEqual(before);
  });

  it('4: an untracked file survives, stays untracked, and is restored if Bob deleted it', async () => {
    const repo = makeRepo();
    write(repo, 'notes/todo.txt', 'my untracked notes\n');
    const before = repoState(repo);
    expect(before.status).toContain('?? notes/todo.txt');
    const { id } = await runMission(repo, (r) => {
      rm(r, 'notes/todo.txt');
      write(r, 'notes/bob.txt', 'bob\n');
    });
    expect((await rollbackMission(id)).httpStatus).toBe(200);
    expect(read(repo, 'notes/todo.txt')).toBe('my untracked notes\n');
    expect(repoState(repo)).toEqual(before);
  });

  it('5: tracked deletions (unstaged and staged) stay deleted even if Bob recreates the files', async () => {
    const repo = makeRepo();
    rm(repo, 'README.md');                 // unstaged deletion
    gitSync(repo, ['rm', '-q', 'src/c.ts']); // staged deletion
    const before = repoState(repo);
    expect(before.status).toContain(' D README.md');
    expect(before.status).toContain('D  src/c.ts');
    const { id } = await runMission(repo, (r) => {
      write(r, 'README.md', 'bob recreated\n');
      write(r, 'src/c.ts', 'bob recreated\n');
    });
    expect((await rollbackMission(id)).httpStatus).toBe(200);
    expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'src/c.ts'))).toBe(false);
    expect(repoState(repo)).toEqual(before);
  });

  it('exact bytes are restored (CRLF and binary content are not normalised)', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'crlf.txt'), 'line1\r\nline2\r\n');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 255, 13, 10, 1, 2]));
    const before = repoState(repo);
    const { id } = await runMission(repo, (r) => {
      fs.writeFileSync(path.join(r, 'crlf.txt'), 'changed\n');
      fs.writeFileSync(path.join(r, 'blob.bin'), Buffer.from([9]));
    });
    expect((await rollbackMission(id)).httpStatus).toBe(200);
    expect(repoState(repo)).toEqual(before);
  });

  it('git-ignored files are not managed: pre-existing ones are untouched, generated ones are left in place', async () => {
    const repo = makeRepo();
    write(repo, 'ignored/cache.bin', 'developer cache\n');
    const { id } = await runMission(repo, (r) => {
      write(r, 'ignored/cache.bin', 'bob regenerated cache\n');
      write(r, 'build.log', 'generated log\n');
      write(r, 'src/a.ts', 'bob\n');
    });
    expect((await rollbackMission(id)).httpStatus).toBe(200);
    expect(read(repo, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(read(repo, 'ignored/cache.bin')).toBe('bob regenerated cache\n');
    expect(read(repo, 'build.log')).toBe('generated log\n');
  });

  it('a file hidden by a .gitignore change Bob made is still removed', async () => {
    const repo = makeRepo();
    const before = repoState(repo);
    const { id } = await runMission(repo, (r) => {
      write(r, 'secret-plan.md', 'bob file\n');
      write(r, '.gitignore', 'ignored/\n*.log\nsecret-plan.md\n');
    });
    expect((await rollbackMission(id)).httpStatus).toBe(200);
    expect(fs.existsSync(path.join(repo, 'secret-plan.md'))).toBe(false);
    expect(repoState(repo)).toEqual(before);
  });
});

describe.concurrent('rollback safety', () => {
  it('14: mission A cannot restore over mission B; B rolls back to A\'s result, then A to the original', async () => {
    const repo = makeRepo();
    const original = repoState(repo);
    const a = await runMission(repo, (r) => write(r, 'a-feature.ts', 'A\n'));
    const afterA = repoState(repo);
    const b = await runMission(repo, (r) => write(r, 'b-feature.ts', 'B\n'));

    const rejected = await rollbackMission(a.id);
    expect(rejected).toMatchObject({ httpStatus: 409, body: { code: 'ROLLBACK_CONFLICT', changedPaths: ['b-feature.ts'] } });
    expect(fs.existsSync(path.join(repo, 'b-feature.ts'))).toBe(true); // nothing was touched

    expect((await rollbackMission(b.id)).httpStatus).toBe(200);
    expect(repoState(repo)).toEqual(afterA);
    expect((await rollbackMission(a.id)).httpStatus).toBe(200);
    expect(repoState(repo)).toEqual(original);
  });

  it('a mission cannot use another mission\'s anchor', async () => {
    const repo = makeRepo();
    const a = await runMission(repo, () => undefined);
    const b = await runMission(repo, () => undefined);
    db().prepare('UPDATE missions SET rollback_ref = ? WHERE id = ?').run(b.anchor.ref, a.id);
    expect(await rollbackMission(a.id)).toMatchObject({ httpStatus: 409, body: { code: 'ANCHOR_MISMATCH' } });
  });

  it('15: a repeated rollback is rejected', async () => {
    const repo = makeRepo();
    const { id } = await runMission(repo, (r) => write(r, 'x.ts', 'x\n'));
    expect((await rollbackMission(id)).httpStatus).toBe(200);
    expect(await rollbackMission(id)).toMatchObject({ httpStatus: 409, body: { code: 'ROLLBACK_ALREADY_DONE' } });
  });

  it('developer edits made after the mission finished block the rollback instead of being discarded', async () => {
    const repo = makeRepo();
    const { id } = await runMission(repo, (r) => write(r, 'src/a.ts', 'bob\n'));
    write(repo, 'src/b.ts', 'developer kept working\n');
    expect(await rollbackMission(id)).toMatchObject({ httpStatus: 409, body: { code: 'ROLLBACK_CONFLICT', changedPaths: ['src/b.ts'] } });
    expect(read(repo, 'src/b.ts')).toBe('developer kept working\n');
    expect(read(repo, 'src/a.ts')).toBe('bob\n');
  });

  it('commits made after the anchor block the rollback (no history rewriting)', async () => {
    const repo = makeRepo();
    const { id } = await runMission(repo, (r) => {
      write(r, 'src/a.ts', 'bob\n');
      gitSync(r, ['add', '-A']);
      gitSync(r, ['-c', 'user.name=Bob', '-c', 'user.email=bob@example.com', 'commit', '-q', '-m', 'bob commit']);
    });
    expect(await rollbackMission(id)).toMatchObject({ httpStatus: 409, body: { code: 'ROLLBACK_HEAD_MOVED' } });
  });

  it('rejects rollback for unknown missions, missions without an anchor, and non-terminal states', async () => {
    expect(await rollbackMission('does-not-exist')).toMatchObject({ httpStatus: 404, body: { code: 'MISSION_NOT_FOUND' } });

    const repo = makeRepo();
    allowRepo(repo);
    const noAnchor = uuidv4();
    db().prepare(`INSERT INTO missions (id, issue_text, repo_path, status) VALUES (?, 'x', ?, 'failed')`).run(noAnchor, repo);
    expect(await rollbackMission(noAnchor)).toMatchObject({ httpStatus: 409, body: { code: 'NO_ROLLBACK_ANCHOR' } });

    for (const status of ['implementing', 'validating', 'awaiting_approval', 'created']) {
      const m = await runMission(makeRepo(), (r) => write(r, 'x.ts', 'x\n'), status);
      expect(await rollbackMission(m.id), status).toMatchObject({ httpStatus: 409, body: { code: 'ROLLBACK_NOT_ALLOWED' } });
      expect(fs.existsSync(path.join(m.anchor.repoRoot, 'x.ts'))).toBe(true);
    }
  });

  it('rejects rollback while the repository is locked by another operation', async () => {
    const repo = makeRepo();
    const { id } = await runMission(repo, (r) => write(r, 'x.ts', 'x\n'));
    const { acquireRepoLock } = await import('../src/git/repoLock');
    const lock = await acquireRepoLock(repo, 'other-mission', 'implementation');
    try {
      expect(await rollbackMission(id)).toMatchObject({ httpStatus: 409, body: { code: 'REPO_LOCKED', lockedBy: 'other-mission' } });
    } finally {
      lock.release();
    }
    expect((await rollbackMission(id)).httpStatus).toBe(200);
  });

  it('rollback status is read-only and reports the same gates as rollback itself', async () => {
    const { getRollbackStatus } = await import('../src/pipeline/rollback');
    const repo = makeRepo();
    const { id, anchor } = await runMission(repo, (r) => write(r, 'x.ts', 'x\n'));
    const evidenceCount = (): number => (db().prepare('SELECT COUNT(*) AS n FROM evidence WHERE mission_id = ?').get(id) as { n: number }).n;
    const before = repoState(repo);
    const n0 = evidenceCount();

    expect(await getRollbackStatus(id)).toEqual({ httpStatus: 200, body: { available: true, anchorRef: anchor.ref } });
    expect(repoState(repo)).toEqual(before);
    expect(evidenceCount()).toBe(n0);
    expect(fs.existsSync(path.join(repo, '.git', 'forgeguard.lock'))).toBe(false);

    write(repo, 'dev.ts', 'developer\n');
    expect((await getRollbackStatus(id)).body).toMatchObject({ available: false, code: 'ROLLBACK_CONFLICT', details: { changedPaths: ['dev.ts'] } });
    fs.rmSync(path.join(repo, 'dev.ts'));

    const { acquireRepoLock } = await import('../src/git/repoLock');
    const lock = await acquireRepoLock(repo, 'someone-else', 'implementation');
    try {
      expect((await getRollbackStatus(id)).body).toMatchObject({ available: false, code: 'REPO_LOCKED' });
    } finally {
      lock.release();
    }
    expect(evidenceCount()).toBe(n0);

    expect((await rollbackMission(id)).httpStatus).toBe(200);
    expect((await getRollbackStatus(id)).body).toMatchObject({ available: false, code: 'ROLLBACK_ALREADY_DONE' });
    expect((await getRollbackStatus('nope')).httpStatus).toBe(404);
  });

  it('records rollback evidence (success and rejection)', async () => {
    const repo = makeRepo();
    const { id, anchor } = await runMission(repo, (r) => write(r, 'x.ts', 'x\n'));
    await rollbackMission(id);
    await rollbackMission(id);
    const ev = db().prepare(`SELECT evidence_type, content FROM evidence WHERE mission_id = ? AND phase_name = 'rollback'`).all(id) as Array<{ evidence_type: string; content: string }>;
    const done = JSON.parse(ev.find((e) => e.evidence_type === 'observation')!.content) as Record<string, unknown>;
    expect(done).toMatchObject({ event: 'rollback_completed', anchorRef: anchor.ref, head: anchor.head, removed: ['x.ts'] });
    expect(done['startedAt']).toBeTruthy();
    expect(JSON.parse(ev.find((e) => e.evidence_type === 'error')!.content)).toMatchObject({ code: 'ROLLBACK_ALREADY_DONE' });
  });
});
