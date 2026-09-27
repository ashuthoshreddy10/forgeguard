/**
 * git.ts — Minimal git runner: argv array, no shell, output captured.
 */

import { spawn } from 'child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  env?: Record<string, string>;
  input?: string;
  /** `-c key=value` settings applied to this invocation only. */
  config?: Record<string, string>;
}

/** Content-exact settings for snapshot/restore: no EOL conversion, no fsmonitor. */
export const EXACT_CONTENT_CONFIG: Record<string, string> = {
  'core.autocrlf': 'false',
  'core.safecrlf': 'false',
  'core.fsmonitor': 'false',
};

/** Identity for ForgeGuard's internal snapshot commits (never on a branch). */
export const FORGEGUARD_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'ForgeGuard',
  GIT_AUTHOR_EMAIL: 'forgeguard@localhost',
  GIT_COMMITTER_NAME: 'ForgeGuard',
  GIT_COMMITTER_EMAIL: 'forgeguard@localhost',
};

export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const configArgs = Object.entries(options.config ?? {}).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
  return new Promise((resolve) => {
    const child = spawn('git', [...configArgs, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(out).toString('utf-8'),
      stderr: Buffer.concat(err).toString('utf-8'),
    }));
    child.stdin.end(options.input ?? '');
  });
}

export class GitError extends Error {
  constructor(readonly args: string[], readonly result: GitResult) {
    super(`git ${args[0] ?? ''} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** Run git and return trimmed stdout; throw GitError on a non-zero exit. */
export async function gitOk(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const r = await git(cwd, args, options);
  if (r.code !== 0) throw new GitError(args, r);
  return r.stdout.trim();
}
