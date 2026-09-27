/**
 * Temporary Git repositories for tests (real git, real files). Cleaned up by cleanupRepos().
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const created: string[] = [];

export function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(repo: string, rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export const DEFAULT_FILES: Record<string, string> = {
  '.gitignore': 'ignored/\n*.log\n',
  'README.md': '# demo\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 2;\n',
  'src/c.ts': 'export const c = 3;\n',
};

/** Create a repository with one commit (unless `commit` is false). Returns its canonical path. */
export function makeRepo(files: Record<string, string> = DEFAULT_FILES, commit = true): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-repo-')));
  created.push(dir);
  gitSync(dir, ['init', '-q', '-b', 'main']);
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  if (commit) {
    gitSync(dir, ['add', '-A']);
    gitSync(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  }
  return dir;
}

export function makeDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-dir-')));
  created.push(dir);
  return dir;
}

/** Add a repository to FORGEGUARD_ALLOWED_REPOS for this test process. */
export function allowRepo(dir: string): void {
  const current = process.env['FORGEGUARD_ALLOWED_REPOS'];
  process.env['FORGEGUARD_ALLOWED_REPOS'] = current ? `${current}${path.delimiter}${dir}` : dir;
}

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (r === '.git') continue;
    if (entry.isDirectory()) out.push(`${r}/`, ...walk(root, r));
    else out.push(r);
  }
  return out;
}

export interface RepoState {
  /** Every path on disk except .git (directories end with '/'), with exact file bytes. */
  files: Record<string, string>;
  /** `git status` (untracked files listed individually). */
  status: string;
  /** Exact staged state: mode, blob id and stage of every index entry. */
  index: string;
  head: string;
}

export function repoState(repo: string): RepoState {
  const files: Record<string, string> = {};
  for (const p of walk(repo).sort()) {
    files[p] = p.endsWith('/') ? '<dir>' : fs.readFileSync(path.join(repo, p)).toString('base64');
  }
  return {
    files,
    status: gitSync(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    index: gitSync(repo, ['ls-files', '--stage']),
    head: gitSync(repo, ['rev-parse', 'HEAD']).trim(),
  };
}

export function cleanupRepos(): void {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
