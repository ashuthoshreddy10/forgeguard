/**
 * snapshot.ts — Immutable, mission-specific rollback anchors built with git plumbing.
 *
 * Creating an anchor never touches the developer's working tree or index:
 *   - index tree  = `write-tree` of a *copy* of the real index (captures staged state)
 *   - work tree   = the on-disk state of every non-ignored file (tracked + untracked),
 *                   hashed into a temporary index seeded with the index tree
 * Both are stored as commits (work → index → HEAD) under a unique ref
 * refs/forgeguard/anchors/<missionId>/<tag>. Design: docs/ROLLBACK_DESIGN.md.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { EXACT_CONTENT_CONFIG, FORGEGUARD_IDENTITY, git, gitOk } from './git';

export class AnchorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface Anchor {
  ref: string;
  commit: string;
  indexCommit: string;
  head: string;
  branch: string;
  workTree: string;
  indexTree: string;
  repoRoot: string;
  createdAt: string;
}

const ANCHOR_PREFIX = 'refs/forgeguard/anchors/';
const RESULT_PREFIX = 'refs/forgeguard/results/';

export function anchorRefPrefix(missionId: string): string {
  return `${ANCHOR_PREFIX}${missionId}/`;
}

export function resultRefFor(anchorRef: string): string {
  return RESULT_PREFIX + anchorRef.slice(ANCHOR_PREFIX.length);
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Canonical root of the Git repository at `repoPath`, or an AnchorError when it is not
 * a Git repository or `repoPath` is not the repository's top level.
 */
export async function resolveRepoRoot(repoPath: string): Promise<string> {
  if (!fs.existsSync(repoPath)) throw new AnchorError('REPO_NOT_GIT', 'Repository path does not exist');
  const r = await git(repoPath, ['rev-parse', '--is-inside-work-tree', '--show-toplevel']);
  const [inside, toplevel] = r.stdout.trim().split(/\r?\n/);
  if (r.code !== 0 || inside !== 'true' || !toplevel) {
    throw new AnchorError('REPO_NOT_GIT', 'Target is not a Git repository');
  }
  const top = fs.realpathSync.native(toplevel);
  if (!samePath(top, fs.realpathSync.native(repoPath))) {
    throw new AnchorError('REPO_NOT_GIT_ROOT', 'Target must be the top-level directory of its own Git repository');
  }
  return top;
}

function tempIndexPath(): string {
  return path.join(os.tmpdir(), `forgeguard-index-${uuidv4()}`);
}

function removeTempIndex(p: string): void {
  fs.rmSync(p, { force: true });
  fs.rmSync(`${p}.lock`, { force: true });
}

async function emptyTree(root: string): Promise<string> {
  return gitOk(root, ['mktree'], { input: '' });
}

/** Tree of the developer's real index, read from a copy so the real index is not written. */
export async function indexTree(root: string): Promise<string> {
  const indexFile = await gitOk(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  if (!fs.existsSync(indexFile)) return emptyTree(root);
  const copy = tempIndexPath();
  try {
    fs.copyFileSync(indexFile, copy);
    const r = await git(root, ['write-tree'], { env: { GIT_INDEX_FILE: copy } });
    if (r.code !== 0) {
      throw new AnchorError('INDEX_UNWRITABLE', `The index cannot be snapshotted (unresolved merge conflicts?): ${r.stderr.trim()}`);
    }
    return r.stdout.trim();
  } finally {
    removeTempIndex(copy);
  }
}

/**
 * Tree of every non-ignored file on disk (tracked and untracked), with exact bytes
 * (no EOL conversion). `seedTree` decides which ignored-but-tracked files are included.
 */
export async function worktreeTree(root: string, seedTree: string): Promise<string> {
  const idx = tempIndexPath();
  const env = { GIT_INDEX_FILE: idx };
  try {
    await gitOk(root, ['read-tree', seedTree], { env });
    await gitOk(root, ['add', '--all', '--', '.'], { env, config: EXACT_CONTENT_CONFIG });
    return await gitOk(root, ['write-tree'], { env });
  } finally {
    removeTempIndex(idx);
  }
}

/** Snapshot of the current state: the index tree and the working-tree tree seeded from it. */
export async function currentState(root: string): Promise<{ indexTree: string; workTree: string }> {
  const idxTree = await indexTree(root);
  return { indexTree: idxTree, workTree: await worktreeTree(root, idxTree) };
}

async function commitTree(root: string, tree: string, parent: string, message: string): Promise<string> {
  return gitOk(root, ['commit-tree', tree, '-p', parent, '-F', '-'], { env: FORGEGUARD_IDENTITY, input: message });
}

/** Create a mission-specific anchor. Throws AnchorError; never modifies the working tree or index. */
export async function createAnchor(repoPath: string, missionId: string): Promise<Anchor> {
  const root = await resolveRepoRoot(repoPath);
  const headResult = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (headResult.code !== 0) throw new AnchorError('NO_COMMITS', 'Repository has no commits; an anchor needs a HEAD commit');
  const head = headResult.stdout.trim();
  const sym = await git(root, ['symbolic-ref', '-q', 'HEAD']);
  const branch = sym.code === 0 ? sym.stdout.trim() : '(detached)';

  const state = await currentState(root);
  const createdAt = new Date().toISOString();
  const tag = uuidv4().slice(0, 8);
  const ref = `${anchorRefPrefix(missionId)}${tag}`;
  const trailers = `ForgeGuard-Mission: ${missionId}\nForgeGuard-Head: ${head}\nForgeGuard-Branch: ${branch}\nForgeGuard-Created: ${createdAt}\n`;

  const indexCommit = await commitTree(root, state.indexTree, head, `ForgeGuard index snapshot\n\n${trailers}`);
  const commit = await commitTree(root, state.workTree, indexCommit, `ForgeGuard rollback anchor\n\n${trailers}`);
  // Empty old-value: fails if the ref already exists, so an anchor is never overwritten.
  await gitOk(root, ['update-ref', '-m', 'forgeguard anchor', ref, commit, '']);

  return { ref, commit, indexCommit, head, branch, workTree: state.workTree, indexTree: state.indexTree, repoRoot: root, createdAt };
}

/** Read an anchor back from git and check that it belongs to `missionId`. */
export async function readAnchor(repoPath: string, ref: string, missionId: string): Promise<Anchor> {
  const root = await resolveRepoRoot(repoPath);
  if (!ref.startsWith(anchorRefPrefix(missionId)) || !/^[0-9a-f]{8}$/.test(ref.slice(anchorRefPrefix(missionId).length))) {
    throw new AnchorError('ANCHOR_MISMATCH', 'The rollback reference does not belong to this mission');
  }
  const c = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (c.code !== 0) throw new AnchorError('ANCHOR_MISSING', 'The rollback anchor no longer exists in the repository');
  const commit = c.stdout.trim();
  const message = await gitOk(root, ['cat-file', 'commit', commit]);
  const trailer = (k: string): string | undefined => new RegExp(`^ForgeGuard-${k}: (.+)$`, 'm').exec(message)?.[1];
  if (trailer('Mission') !== missionId) {
    throw new AnchorError('ANCHOR_MISMATCH', 'The rollback anchor was created for a different mission');
  }
  const [indexCommit, head, workTree, indexTreeId] = (await gitOk(root, [
    'rev-parse', `${commit}^1`, `${commit}^1^1`, `${commit}^{tree}`, `${commit}^1^{tree}`,
  ])).split(/\r?\n/);
  if (!indexCommit || !head || !workTree || !indexTreeId || trailer('Head') !== head) {
    throw new AnchorError('ANCHOR_CORRUPT', 'The rollback anchor is inconsistent');
  }
  return {
    ref, commit, indexCommit, head, workTree, indexTree: indexTreeId,
    branch: trailer('Branch') ?? '(unknown)',
    repoRoot: root,
    createdAt: trailer('Created') ?? '',
  };
}

export function deleteAnchor(anchor: Anchor): Promise<string> {
  return gitOk(anchor.repoRoot, ['update-ref', '-d', anchor.ref, anchor.commit]);
}

/** Record the state ForgeGuard left behind, so later foreign changes can be detected. */
export async function recordResultSnapshot(anchor: Anchor, missionId: string): Promise<{ ref: string; workTree: string; indexTree: string }> {
  const state = await currentState(anchor.repoRoot);
  const indexCommit = await commitTree(anchor.repoRoot, state.indexTree, anchor.commit,
    `ForgeGuard result index\n\nForgeGuard-Mission: ${missionId}\n`);
  const commit = await commitTree(anchor.repoRoot, state.workTree, indexCommit,
    `ForgeGuard result snapshot\n\nForgeGuard-Mission: ${missionId}\nForgeGuard-Anchor: ${anchor.ref}\n`);
  const ref = resultRefFor(anchor.ref);
  await gitOk(anchor.repoRoot, ['update-ref', '-m', 'forgeguard result', ref, commit]);
  return { ref, ...state };
}

export async function readResultSnapshot(anchor: Anchor): Promise<{ workTree: string; indexTree: string } | null> {
  const ref = resultRefFor(anchor.ref);
  const r = await git(anchor.repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (r.code !== 0) return null;
  const [grandparent, workTree, indexTreeId] = (await gitOk(anchor.repoRoot, [
    'rev-parse', `${ref}^1^1`, `${ref}^{tree}`, `${ref}^1^{tree}`,
  ])).split(/\r?\n/);
  if (grandparent !== anchor.commit || !workTree || !indexTreeId) return null;
  return { workTree, indexTree: indexTreeId };
}

interface TreeChange { status: string; newMode: string; path: string }

/** Raw diff between two trees (no rename detection), parsed from -z output. */
export async function diffTrees(root: string, from: string, to: string): Promise<TreeChange[]> {
  const r = await git(root, ['diff-tree', '-r', '-z', '--raw', '--no-renames', from, to]);
  if (r.code !== 0) throw new AnchorError('DIFF_FAILED', r.stderr.trim());
  const parts = r.stdout.split('\0');
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    if (!meta.startsWith(':')) break;
    const [, newMode = '', , , status = ''] = meta.slice(1).split(' ');
    changes.push({ status: status.charAt(0), newMode, path: parts[i + 1]! });
  }
  return changes;
}

function insideRoot(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const relBack = path.relative(root, abs);
  if (relBack === '' || relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw new AnchorError('UNSAFE_PATH', 'Refusing to touch a path outside the repository');
  }
  return abs;
}

function pruneEmptyParents(root: string, abs: string): void {
  let dir = path.dirname(abs);
  for (;;) {
    const rel = path.relative(root, dir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Restore the working tree and index to exactly the anchor state.
 * Files created after the anchor are removed; changed/deleted files get their anchor
 * content back; the index is reset to the anchor's index tree (staged state).
 */
export async function restoreAnchor(anchor: Anchor): Promise<{ removed: string[]; restored: string[] }> {
  const root = anchor.repoRoot;
  const removed = new Set<string>();
  const restored = new Set<string>();

  await gitOk(root, ['read-tree', anchor.indexTree]);

  // A restored .gitignore can make previously ignored files visible, hence a few passes.
  for (let pass = 0; pass < 3; pass++) {
    const now = await worktreeTree(root, anchor.indexTree);
    if (now === anchor.workTree) break;
    const changes = await diffTrees(root, anchor.workTree, now);
    if (changes.some((c) => c.newMode === '160000')) {
      throw new AnchorError('ROLLBACK_UNSUPPORTED', 'A nested Git repository was created after the anchor; remove it manually');
    }
    for (const c of changes.filter((x) => x.status === 'A')) {
      const abs = insideRoot(root, c.path);
      fs.rmSync(abs, { force: true });
      pruneEmptyParents(root, abs);
      removed.add(c.path);
    }
    const toRestore = changes.filter((x) => x.status !== 'A').map((x) => x.path);
    if (toRestore.length > 0) {
      toRestore.forEach((p) => insideRoot(root, p));
      await gitOk(root, ['restore', `--source=${anchor.commit}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        config: EXACT_CONTENT_CONFIG,
        env: { GIT_LITERAL_PATHSPECS: '1' },
        input: toRestore.join('\0'),
      });
      toRestore.forEach((p) => restored.add(p));
    }
  }

  await git(root, ['update-index', '-q', '--refresh']);
  const after = await currentState(root);
  if (after.workTree !== anchor.workTree || after.indexTree !== anchor.indexTree) {
    throw new AnchorError('ROLLBACK_VERIFY_FAILED', 'After rollback the repository does not match the anchor');
  }
  return { removed: [...removed], restored: [...restored] };
}
