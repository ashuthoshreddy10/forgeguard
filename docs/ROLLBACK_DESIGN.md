# Rollback Design — Mission-Specific Immutable Anchors

ForgeGuard lets Bob change a developer's repository. Rollback has to put back exactly what was there before Bob started, including the developer's own uncommitted work. It must never damage anything else.

- Implementation: [`backend/src/git/snapshot.ts`](../backend/src/git/snapshot.ts), [`backend/src/git/repoLock.ts`](../backend/src/git/repoLock.ts), [`backend/src/pipeline/rollback.ts`](../backend/src/pipeline/rollback.ts)
- Tests: [`backend/tests/rollback.test.ts`](../backend/tests/rollback.test.ts) (real git in temporary repositories), plus the pipeline cases in [`backend/tests/pipeline.test.ts`](../backend/tests/pipeline.test.ts)

## 1. What was replaced and why

The old mechanism was `git stash push -u` before implementation and `git stash pop` to roll back. It had these defects:

- On a clean tree, no stash was created, but a rollback reference was recorded anyway.
- `stash push` **removed** the developer's work from the tree before Bob ran.
- `stash pop` re-applied that work **on top of** Bob's changes instead of reverting them.
- It popped the top of a global stack, which could be another mission's stash.
- It ignored the repository state entirely.

The stash is no longer used anywhere.

## 2. The anchor

The anchor is created right before Bob's implementer task starts, inside the implementation phase and while the repository lock is held. It is built only from git plumbing, which writes objects and refs but **never touches the developer's working tree or index**:

| Step | Command | What it captures |
|---|---|---|
| 1 | copy `.git/index` → temp file; `GIT_INDEX_FILE=<copy> git write-tree` | **index tree**: exactly what is staged (staged edits, staged additions, staged deletions) |
| 2 | temp index seeded with the index tree; `git add --all` (with `core.autocrlf=false`); `git write-tree` | **work tree**: every non-ignored file on disk, with exact bytes. That covers tracked modifications, deletions and untracked files. |
| 3 | `git commit-tree <index tree> -p HEAD` | index commit (its parent is the real HEAD) |
| 4 | `git commit-tree <work tree> -p <index commit>` | **anchor commit**, with trailers `ForgeGuard-Mission`, `ForgeGuard-Head`, `ForgeGuard-Branch` and `ForgeGuard-Created` |
| 5 | `git update-ref refs/forgeguard/anchors/<missionId>/<8-hex> <anchor> ""` | a unique ref. The empty old-value makes the command fail if the ref already exists. |

- The ref name is stored in `missions.rollback_ref`.
- Evidence row `rollback_anchor_created` records: ref, commits, HEAD, branch, both trees, the repository path and `createdAt`.
- The anchor commits are on no branch, so they never show up in the developer's history. The ref keeps them safe from garbage collection.
- Internal commits use the identity `ForgeGuard <forgeguard@localhost>`, passed through environment variables. Git config is never modified.

**Why two trees:** the work tree alone would lose the difference between staged and unstaged changes. With both trees, rollback restores the files on disk *and* the staging area. For example, a partially staged file (`MM`) comes back as `MM`.

**Exact bytes:** snapshots are taken with `core.autocrlf=false`, and so are restores, so CRLF files and binary files come back byte-for-byte. This matters on this machine, where the global setting is `autocrlf=true`; the tests cover it.

### When implementation is refused

Bob's implementer is **never** started, the phase fails, the mission fails, and `error` evidence is written, when any of these happen:

| Condition | Code |
|---|---|
| The target is not a Git repository | `REPO_NOT_GIT` (also checked in `/start` preflight: HTTP 422, before any Bob call) |
| The target is a subdirectory, not the top level of its repository | `REPO_NOT_GIT_ROOT` |
| The repository has no commits | `NO_COMMITS` |
| The index can't be snapshotted (unresolved merge conflicts) | `INDEX_UNWRITABLE` |
| Another mission holds the repository lock | `REPO_LOCKED` |
| The working tree changed between baseline validation and implementation | `REPO_CHANGED_SINCE_BASELINE` (the anchor is deleted again) |

The last check exists because baseline validation now runs at the start of the mission, before analysis and approval. If the tree changed while the plan was waiting for approval, the baseline no longer describes the code Bob would change, so ForgeGuard refuses rather than compare against stale evidence.

## 3. The result snapshot

When the pipeline ends, whether it succeeded or failed, and while it still holds the repository lock, ForgeGuard records the state it left behind. The same two trees are stored as `refs/forgeguard/results/<missionId>/<tag>`, whose grandparent is the anchor.

Rollback uses this snapshot to detect **anything that changed after the mission**: the developer kept working, or a later mission changed the repository. Evidence rows: `result_snapshot_recorded` or `result_snapshot_failed`.

## 4. Rollback (`POST /api/missions/:id/rollback`)

Gates, in order. Each rejection returns a structured `{ code, error }` and writes `error` evidence (`phase_name = 'rollback'`):

| # | Gate | Rejection |
|---|---|---|
| 1 | The mission exists | 404 `MISSION_NOT_FOUND` |
| 2 | It isn't already rolled back | 409 `ROLLBACK_ALREADY_DONE` |
| 3 | Its status is terminal: `complete` or `failed` (not while analysing, awaiting approval, implementing or validating) | 409 `ROLLBACK_NOT_ALLOWED` |
| 4 | It has an anchor | 409 `NO_ROLLBACK_ANCHOR` |
| 5 | The repository is still in the allow-list | 403 `REPO_NOT_ALLOWED` |
| 6 | The anchor ref belongs to **this** mission (ref prefix and the `ForgeGuard-Mission` trailer), is intact, and still exists | 409 `ANCHOR_MISMATCH` / `ANCHOR_CORRUPT` / `ANCHOR_MISSING` |
| 7 | The repository lock can be acquired | 409 `REPO_LOCKED` |
| 8 | HEAD is still the anchor's HEAD, so no commits were made (ForgeGuard doesn't rewrite branch history) | 409 `ROLLBACK_HEAD_MOVED` |
| 9 | The current state equals this mission's result snapshot (nothing changed since the mission ended) | 409 `ROLLBACK_CONFLICT`, with up to 20 changed paths |

Then the restore runs:

1. `git read-tree <anchor index tree>` restores the staging area exactly.
2. Compute the current working-tree tree and diff it against the anchor's work tree (`diff-tree -r -z --raw --no-renames`):
   - **Added since the anchor:** the file is deleted, and directories left empty are removed.
   - **Modified, deleted or type-changed:** the file is restored with `git restore --source=<anchor> --worktree` (literal pathspecs, NUL-separated, `autocrlf=false`).
3. Repeat step 2, up to 3 passes in total. Restoring `.gitignore` can make files visible that Bob had hidden by editing it.
4. `git update-index --refresh`, then **verify**: both trees must equal the anchor, or the result is 500 `ROLLBACK_VERIFY_FAILED`.
5. Set the mission status to `rolled_back`, write `rollback_completed` evidence (anchor, HEAD, branch, repository, removed and restored paths, start and end times), and emit `rollback.completed`.

Unexpected errors return a generic 500 `ROLLBACK_FAILED`. The full git diagnostics go to evidence only.

## 5. Developer-change preservation

| Before implementation | After rollback |
|---|---|
| Unstaged edit to a tracked file | Same content, still unstaged, even if Bob edited the same file |
| Staged edit, or partially staged file | Same index entry and same working-tree content |
| Staged new file | Still staged, even if Bob deleted it |
| Untracked, non-ignored file | Same content, still untracked, even if Bob deleted it |
| Unstaged or staged deletion | Still deleted, even if Bob recreated the file |
| Edits made **after** the mission finished | Rollback is refused (`ROLLBACK_CONFLICT`), so nothing is discarded |

## 6. Ignored files

Git-ignored files are **not managed** by rollback:

- Existing ignored files (build output, caches, `node_modules`) are neither snapshotted nor touched.
- Ignored files that Bob or validation generate (for example `dist/`) are left in place.

This is deliberate: the anchor would otherwise have to copy dependency trees, and a rollback would delete developer caches. A file Bob creates and then hides by editing `.gitignore` is still removed, because `.gitignore` is restored first.

Tracked files that match an ignore pattern are included, because the snapshot is seeded from the index.

## 7. Repository lock

- **Where:** the file `<git common dir>/forgeguard.lock`, created with `O_EXCL` (`wx`). It's shared across ForgeGuard processes and across git worktrees of the same repository.
- **Contents:** mission ID, purpose, PID, hostname and acquisition time.
- **Release:** it's removed only by its owner.
- **Held during:**
  - baseline validation (purpose `baseline`)
  - the whole span from anchor creation through implementation, post-implementation validation and the result snapshot (`implementation`)
  - a rollback (`rollback`)
- **Not held** while Bob analyses or the plan waits for approval. No ForgeGuard process writes to the repository then. If the tree changes meanwhile, the baseline check in §2 catches it.
- **Stale lock:** if the recorded PID is dead on the same host, the lock is taken over and an `observation` evidence row records the takeover.
- **When the lock is held:**
  - `/start` answers 409 `REPO_LOCKED` without failing the mission.
  - A pipeline that reaches a lock it can't get fails its phase with `REPO_LOCKED`.
  - Rollback answers 409.

## 8. Mission-specific behaviour across missions

Suppose mission A runs, and then mission B runs on the same repository:

- **Rolling back A first:** refused (`ROLLBACK_CONFLICT`), because the tree now contains B's changes. A's anchor would discard them.
- **Rolling back B:** restores exactly A's result state.
- **Then rolling back A:** restores the original state.
- **Pointing A's `rollback_ref` at B's anchor:** refused (`ANCHOR_MISMATCH`).

Re-running a mission whose anchor hasn't been rolled back is refused by `/start` with 409 `ROLLBACK_PENDING`. A re-run after rollback clears `rollback_ref` and creates a new, unique anchor.

## 9. Known limits

- A nested Git repository that Bob creates inside the target isn't removed automatically (`ROLLBACK_UNSUPPORTED`). Submodules aren't specially handled.
- Empty directories that existed before the anchor can be removed if Bob created files in them, because git doesn't track directories.
- Rollback isn't atomic. If a filesystem error interrupts it midway, the anchor and result refs stay in place, and the evidence names both for manual recovery (`git read-tree` / `git restore --source=<anchor>`).
- Files covered by `.gitattributes` filters (for example `eol`, or LFS) are restored the way git checks them out.
