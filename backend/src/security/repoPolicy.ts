/**
 * repoPolicy.ts — Which repositories ForgeGuard may run npm scripts and Bob in.
 *
 * Default: only the bundled demo-app. FORGEGUARD_ALLOWED_REPOS replaces the default
 * with an explicit list (separated by the platform path delimiter: ';' on Windows,
 * ':' elsewhere). Paths are compared after canonicalisation (realpath, which resolves
 * '..', symlinks and junctions) and must match an allowed repository exactly.
 */

import fs from 'fs';
import path from 'path';

type Env = Record<string, string | undefined>;

export const DEFAULT_REPO = path.resolve(__dirname, '..', '..', '..', 'demo-app');

export type RepoCheck =
  | { ok: true; path: string }
  | { ok: false; code: 'REPO_NOT_ALLOWED' | 'INVALID_REPO_PATH'; error: string };

function canonical(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function key(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** Canonical paths of the allowed repositories that exist. */
export function getAllowedRepos(env: Env = process.env): string[] {
  const raw = env['FORGEGUARD_ALLOWED_REPOS']?.trim();
  const entries = raw ? raw.split(path.delimiter).map((s) => s.trim()).filter(Boolean) : [DEFAULT_REPO];
  const out: string[] = [];
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) {
      console.warn('[security] Ignoring relative FORGEGUARD_ALLOWED_REPOS entry (must be absolute)');
      continue;
    }
    const c = canonical(entry);
    if (c) out.push(c);
    else console.warn('[security] Ignoring FORGEGUARD_ALLOWED_REPOS entry that does not exist');
  }
  return out;
}

/**
 * Resolve a requested repository to its canonical allowed path. `undefined` means the
 * default repository. Error messages never echo the resolved filesystem path.
 */
export function resolveAllowedRepo(requested: unknown, env: Env = process.env): RepoCheck {
  const allowed = getAllowedRepos(env);
  if (requested === undefined || requested === null || requested === '') {
    const def = allowed[0];
    return def ? { ok: true, path: def } : { ok: false, code: 'REPO_NOT_ALLOWED', error: 'No allowed repository is configured' };
  }
  if (typeof requested !== 'string' || requested.length > 1024 || requested.includes('\0')) {
    return { ok: false, code: 'INVALID_REPO_PATH', error: 'repoPath must be a string path' };
  }
  if (!path.isAbsolute(requested)) {
    return { ok: false, code: 'REPO_NOT_ALLOWED', error: 'repoPath must be an absolute path to an allowed repository' };
  }
  const resolved = canonical(requested);
  if (resolved && allowed.some((a) => key(a) === key(resolved))) return { ok: true, path: resolved };
  return { ok: false, code: 'REPO_NOT_ALLOWED', error: 'Repository path is not in the allow-list' };
}
