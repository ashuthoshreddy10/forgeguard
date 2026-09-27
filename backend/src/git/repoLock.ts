/**
 * repoLock.ts — One ForgeGuard operation per repository at a time.
 *
 * The lock is a file created with O_EXCL in the repository's git common dir, so it
 * holds across ForgeGuard processes and git worktrees. A lock whose holder process
 * is gone on this host is stale and is taken over.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { gitOk } from './git';

export type LockPurpose = 'baseline' | 'implementation' | 'rollback';

export interface LockHolder {
  missionId: string;
  purpose: LockPurpose;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export class RepoLockedError extends Error {
  readonly code = 'REPO_LOCKED';
  constructor(readonly holder: LockHolder | null) {
    super(holder
      ? `Repository is locked by mission ${holder.missionId} (${holder.purpose}, since ${holder.acquiredAt})`
      : 'Repository is locked by another ForgeGuard operation');
  }
}

export interface RepoLock {
  readonly lockPath: string;
  readonly holder: LockHolder;
  /** Evidence of a stale lock that was taken over, if any. */
  readonly tookOverStale: LockHolder | null;
  release(): void;
}

async function lockPathFor(repoRoot: string): Promise<string> {
  const commonDir = await gitOk(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return path.join(commonDir, 'forgeguard.lock');
}

function readHolder(lockPath: string): LockHolder | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockHolder;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(holder: LockHolder | null): boolean {
  return !!holder && holder.hostname === os.hostname() && Number.isInteger(holder.pid) && !isAlive(holder.pid);
}

/** Current holder of the repository lock, or null if it is free (or stale). */
export async function readRepoLock(repoRoot: string): Promise<LockHolder | null> {
  const lockPath = await lockPathFor(repoRoot);
  if (!fs.existsSync(lockPath)) return null;
  const holder = readHolder(lockPath);
  return isStale(holder) ? null : holder ?? { missionId: 'unknown', purpose: 'implementation', pid: -1, hostname: '', acquiredAt: '' };
}

/** Acquire the repository lock or throw RepoLockedError. */
export async function acquireRepoLock(repoRoot: string, missionId: string, purpose: LockPurpose): Promise<RepoLock> {
  const lockPath = await lockPathFor(repoRoot);
  const holder: LockHolder = { missionId, purpose, pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() };
  let tookOverStale: LockHolder | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(holder), { flag: 'wx' });
      let released = false;
      return {
        lockPath, holder, tookOverStale,
        release: () => {
          if (released) return;
          released = true;
          const current = readHolder(lockPath);
          if (current && current.missionId === holder.missionId && current.pid === holder.pid && current.acquiredAt === holder.acquiredAt) {
            fs.rmSync(lockPath, { force: true });
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readHolder(lockPath);
      if (attempt === 0 && isStale(existing)) {
        tookOverStale = existing;
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      throw new RepoLockedError(existing);
    }
  }
  throw new RepoLockedError(readHolder(lockPath));
}
