# Release Verdict — Deterministic Decision Logic

ForgeGuard's release decision is computed by code from stored validation evidence. IBM Bob's release report is a narrative. It is recorded next to the verdict and can never change it.

**Rule: no evidence, no claim.**

- Implementation: [`backend/src/pipeline/releaseVerdict.ts`](../backend/src/pipeline/releaseVerdict.ts)
- Tests: [`backend/tests/releaseVerdict.test.ts`](../backend/tests/releaseVerdict.test.ts), [`backend/tests/pipeline.test.ts`](../backend/tests/pipeline.test.ts)

## 1. Evidence: baseline and post-implementation runs

The same validation policy runs twice against the target repository:

| Run | When | `validation_runs.run_kind` | `validation_runs.phase_id` |
|---|---|---|---|
| **Baseline** | At the start of the mission (inside Phase 1, before any Bob call). Since Milestone 5, implementation is refused if the working tree changes afterwards (`REPO_CHANGED_SINCE_BASELINE`) | `baseline` | that mission run's `repo_understanding` phase |
| **Post** | Phase 5, after implementation | `post` | that mission run's `validation` phase |

The **validation policy** (`REQUIRED_VALIDATION_COMMANDS`) is the list of commands that must run:

```
npm run lint
npm test
npm run typecheck
npm run build
```

Each command creates one row in `validation_runs` holding:

- the exact command
- verbatim `stdout` and `stderr` (secrets redacted)
- `exit_code`
- `passed` (1 only when `exit_code = 0`)
- `started_at`, `completed_at` and `duration_ms`

Nothing is hardcoded. A command that cannot be spawned is recorded with exit code 1 and the spawn error in `stderr`.

Baseline failures do not stop the pipeline, because they describe the repository as it was before the change.

**Schema change:** one column, `validation_runs.run_kind TEXT NOT NULL DEFAULT 'post' CHECK(run_kind IN ('baseline','post'))`. Existing databases get it through an `ALTER TABLE` in `database.ts`. Rows written before this change came from Phase 5, so they default to `post`.

**Scoping:** a mission can run more than once. `loadReleaseVerdict(db, missionId)` therefore reads:

- baseline rows linked to the **latest** `repo_understanding` phase row (the start of the latest run)
- the `implementation` phase created after it, which gives the implementation outcome
- post rows linked to the `validation` phase created **after** that implementation phase

Rows from earlier runs are never mixed in.

## 2. Per-command classification

Each required command is classified by comparing its baseline result (B) with its post result (P):

| Baseline (B) | Post (P) | Classification | Effect on verdict |
|---|---|---|---|
| pass | pass | `pass` | none |
| fail | pass | `fixed` | none (reported as an improvement) |
| missing | pass | `pass_without_baseline` | at most **conditional** |
| fail | fail | `preexisting_failure` | at most **conditional**: not a regression, but not ignored |
| pass | fail | `regression` | **blocked** |
| missing | fail | `unclassified_failure` | **blocked**: the failure can't be shown to be pre-existing |
| any | timed out | `timed_out` | **blocked**: a killed command is not evidence of anything |
| any | missing | `missing_post` | **blocked**: a required validation is missing |

A **timed-out baseline** counts as *missing* baseline evidence: a passing post run gives `pass_without_baseline`, and a failing one gives `unclassified_failure`. Timeouts are described in [VALIDATION_POLICY.md](VALIDATION_POLICY.md).

Commands outside the policy may exist in the table, but they don't affect the verdict.

## 3. Verdict rules (evaluated in this order)

| # | Condition | Verdict |
|---|---|---|
| 1 | Any row is malformed (see below) | **none** (`null`) |
| 2 | The implementation phase `failed` or was `skipped` | **blocked** |
| 3 | There are no baseline rows and no post rows | **none** (`null`) |
| 4 | Any command is `regression`, `unclassified_failure`, `timed_out` or `missing_post` | **blocked** |
| 5 | Any command is `preexisting_failure` or `pass_without_baseline`, or the implementation outcome is unknown | **conditional** |
| 6 | Otherwise (every command is `pass` or `fixed`) | **ready** |

What the four outcomes mean:

- **ready**: every required command passed after implementation; each has a baseline result; nothing regressed; the implementation phase completed.
- **conditional**: nothing got worse, but the evidence doesn't support "ready". Either a failure already existed in the baseline and is still there, or baseline evidence is missing for a command that now passes.
- **blocked**: the release gate is closed. There is a detected regression, a failure that can't be classified, a missing required post-implementation result, or the implementation didn't succeed.
- **none** (`null`): there's nothing trustworthy to evaluate, so no verdict is made. This happens with zero rows or with malformed data.

A row is **malformed** when any of these hold:

- the command is missing or empty
- `run_kind` doesn't match the bucket the row was read into
- the run never completed (`completed_at` is null)
- `exit_code` isn't an integer
- `passed` isn't 0 or 1
- `passed` contradicts `exit_code`
- `timed_out` isn't 0 or 1, or a timed-out row has a non-null `exit_code` or `passed = 1`
- a command appears twice in the same bucket

One malformed row voids the whole verdict. The evidence store can't be trusted in part.

The result object has these fields:

- `verdict`
- `reasons[]`: human-readable, one per blocking or conditional command
- `commands[]`: per command, the baseline and post outcome, both exit codes, both run IDs and the classification
- `requiredCommands`
- `implementationSucceeded`

## 4. Effect on the pipeline and mission state

| Verdict | Phase 5 (`validation`) | Phase 6 (Bob report) | Mission |
|---|---|---|---|
| ready | completed | runs | `complete`; `mission.completed.releaseReadiness = "ready"` |
| conditional | completed | runs | `complete`; `releaseReadiness = "conditional"`, with reasons |
| blocked | **failed**: `Release blocked: <reasons>` | skipped | `failed` |
| none | **failed**: `No release verdict: <reasons>` | skipped | `failed` |

The mission status CHECK constraint has no `blocked` value, and it was deliberately left unchanged. A blocked release is therefore a `failed` mission whose `error_message` starts with `Phase "validation" failed: Release blocked:`.

The verdict is stored in three places:

- the `validation` phase output
- `missions.validation_result` (`{ releaseVerdict, post }`)
- an `observation` evidence row, `Deterministic release verdict: …`

`GET /api/missions/:id/release-verdict` recomputes the verdict from the database rows at any time.

## 5. Bob's release report (narrative only)

Phase 6 still asks Bob for a release report. Bob's prompt includes:

- the per-command baseline/post comparison
- the verdict reasons
- the post-implementation output
- the deterministic verdict

Bob is told its report does not change the verdict.

The report must still be well formed: a recognised `releaseReadiness` (`ready|conditional|blocked`; the legacy `not-ready` counts as `blocked`) and a non-empty `summary`. If it isn't, Phase 6 fails, as it did in Milestones 1 and 2. When that happens the mission is `failed`, but the deterministic verdict is still in the database and available from the endpoint.

`reconcileBobAssessment(verdict, bob)` compares Bob's assessment with the verdict:

- **They agree:** `agreesWithVerdict: true`, `discrepancy: null`.
- **They disagree** (for example, Bob says `ready` while the evidence gives `conditional`, or Bob says `blocked` while validation is green):
  - the deterministic verdict is used
  - the disagreement is kept, not discarded, as `discrepancy` in `missions.release_report`, in the `mission.completed` payload, and in an `observation` evidence row starting `Verdict discrepancy:`

The stored `missions.release_report` has this shape:

```json
{
  "verdict": "conditional",
  "verdictSource": "deterministic (validation_runs)",
  "verdictReasons": ["\"npm run lint\" failed before and after implementation (...): pre-existing failure, not a regression"],
  "bobAssessment": "ready",
  "agreesWithVerdict": false,
  "discrepancy": "Bob's narrative assessed \"ready\" but the deterministic verdict from validation evidence is \"conditional\"; the deterministic verdict is used",
  "bobNarrative": { "releaseReadiness": "ready", "summary": "..." }
}
```

Bob can never produce a `blocked` mission from green evidence. A `blocked` verdict never reaches Bob, so Bob can never promote it either.

## 6. Worked examples

| Baseline (lint / test / typecheck / build) | Post (lint / test / typecheck / build) | Verdict |
|---|---|---|
| pass / pass / pass / pass | pass / pass / pass / pass | **ready** |
| pass / pass / FAIL / pass | pass / pass / FAIL / pass | **conditional**: typecheck is a pre-existing failure |
| pass / pass / pass / pass | FAIL / pass / pass / pass | **blocked**: lint regression |
| pass / pass / FAIL / pass | pass / FAIL / FAIL / pass | **blocked**: test regression (typecheck is still pre-existing) |
| pass / pass / pass / FAIL | pass / pass / pass / pass | **ready**: build fixed |
| (none) / pass / pass / pass | pass / pass / pass / pass | **conditional**: lint has no baseline |
| pass / pass / pass / pass | pass / pass / (none) / pass | **blocked**: typecheck missing after implementation |
| (no rows) | (no rows) | **none** |
