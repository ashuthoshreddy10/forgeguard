# ForgeGuard — Engineering Audit (Claude Code)

**Date:** 2026-09-26 · **Auditor:** Claude Code (Opus 5.5) · **Scope:** the entire repository at `%USERPROFILE%\.bob\playground`

This audit was done after IBM Bob 2.0 built the project. Every finding below comes from reading the source or from running a command. Nothing was changed in the code during the audit. The only new file is this document. It does not rely on earlier implementation reports.

---

## 1. Current architecture (as found)

```
frontend/  React 18 + Vite 5 + Tailwind + Zustand     (proxy /api and /ws -> :3001)
backend/   Express 4 + ws + better-sqlite3 (CommonJS, ts-node-dev)
  routes/missions.ts      REST: create/list/get/start/approve/rollback + evidence/tasks/phases/validation-runs
  pipeline/MissionOrchestrator.ts  6 phases in one async function, in-process, fire-and-forget
  pipeline/PhaseRunner.ts phase rows + WS broadcast
  bob/BobClient.ts        provider interface -> BobShellClient (spawns `bob`) | BobApiClient (stub)
  bob/TaskManager.ts      agent_tasks rows + prompt/response evidence rows
  ws/EventBus.ts          /ws, optional ?missionId filter
  db/schema.sql           missions, pipeline_phases, agent_tasks, evidence, artifacts, validation_runs
demo-app/  Express + TS target repo with seeded issues, Vitest tests, ESLint flat config
.bob/      rules/forgeguard.md + 7 skills (SKILL.md)
docs/      ARCHITECTURE, BOB_WORKFLOW, IMPLEMENTATION_PLAN, AUDIT_FIX_PLAN
```

- The repository is **not a git repository**. Neither the root nor `demo-app/` is under git.
- `tests/` is referenced in the README but **does not exist**.

## 2. Commands executed and results

Environment: Windows 11, Node v22.20.0, npm 10.9.3, git 2.49.0, Bob Shell CLI **2.0.5** (`%APPDATA%\npm\bob.cmd`).

| # | Directory | Command | Exit | Result |
|---|---|---|---|---|
| 1 | backend | `npm ci` | 0 | 258 packages |
| 2 | frontend | `npm ci` | 0 | 252 packages |
| 3 | demo-app | `npm ci` | 0 | 328 packages |
| 4 | backend | `npm run typecheck` | 0 | clean |
| 5 | backend | `npm run build` | 0 | emits `dist/`, **without** `schema.sql` |
| 6 | backend | `npm test` | **1** | `No test files found` — the backend has zero tests |
| 7 | backend | `node verify-db.js` | **1** | `Cannot find module './src/db/database'` (it requires `.ts` from plain Node) |
| 8 | backend | `npm start` | **1** | `ENOENT … dist\db\schema.sql` — the production start crashes |
| 9 | backend | `npm run dev` | — | starts, `/api/health` OK |
| 10 | frontend | `npm run typecheck` | 0 | clean |
| 11 | frontend | `npm run build` | 0 | 171 kB JS / 17.5 kB CSS |
| 12 | frontend | `npm run lint` | **2** | `ESLint couldn't find a configuration file` |
| 13 | demo-app | `npm run typecheck` | **2** | TS6059 ×3: `tests/*.ts` not under `rootDir: ./src` |
| 14 | demo-app | `npm test` | 0 | **29 / 29 passed** (pricing 8, inventory 8, utils 13) |
| 15 | demo-app | `npm run lint` | **1** | `src/server.ts`: `process`/`console` `no-undef` (3 errors) — no Node globals configured |
| 16 | demo-app | `npm run build` | **2** | same TS6059 as #13 |
| 17 | any | `bob --help`, `bob run --help` | 0 | real headless interface: `bob run [--mode] [-w] [--max-turns] [-f json] [--disable-tool-groups] <prompt>` |
| 18 | demo-app | `bob --chat-mode plan --auth-method api-key` | 1 | `unknown option '--chat-mode'` (rejected at parse time, so no prompt was sent) |
| 19 | node | `spawn('bob', …)` without a shell | — | `ENOENT` |
| 20 | node | `spawn('bob.cmd', …)` without a shell | — | `EINVAL` (Node ≥ 18.20 blocks `.cmd` without a shell) |

Notes:
- #13, #15 and #16 are **tooling/config faults**, not the intentional seeded issues. As long as they exist, the validation phase can never go green, whatever Bob changes.
- `.env` is byte-identical to `.env.example`, so `BOBSHELL_API_KEY` is empty. Its value was never printed.

## 3. Critical-flow test (live run)

This was a scripted run against `npm run dev` with a throwaway SQLite DB. It created a mission, subscribed over WS, started the mission, approved it, waited for completion and tried a rollback. Bob could not be spawned (see #19), so **no Bob credits were used**.

| Step | Observed |
|---|---|
| Create mission | 201, `repo_path` defaults to `demo-app` |
| Create with `repoPath: "C:/Windows"` | **201 — accepted** (see S1) |
| Start | 202; a second start is correctly rejected with 409 |
| Phases 1–3 | each "completed" in 11–66 ms |
| Every Bob task (9 total) | `failed` — `Failed to spawn Bob Shell: spawn bob ENOENT` |
| `plan.ready` | `changePlan: null`; the mission's `change_plan` is `""` |
| Approve | accepted (an **empty plan can be approved**) |
| Rollback anchor | `git stash failed (exit 128): not a git repository` → `rollback_ref = null`; the pipeline continues anyway |
| Implementation | "completed" in 10 ms (the Bob task failed) |
| Validation (real) | `npm run lint` exit 1 · `npm test` exit 0 · `npm run typecheck` exit 2 — stored verbatim ✅ |
| Release report | "completed" in 10 ms; `release_report = ""` |
| Mission end state | **`complete`** |
| `mission.completed` event | **`releaseReadiness: "conditional"`, `summary: "Pipeline completed."`** — hardcoded defaults, not evidence |
| Evidence | 9 rows, all `prompt`. **No error evidence** for the 9 failures |
| Rollback | 400 `No rollback ref found` |
| WS events seen | `mission.updated`, `phase.*`, `plan.ready`, `validation.*`, `mission.completed`. **Never emitted:** `agent.*`, `evidence.created`, `rollback.completed` |

**Conclusion:** the orchestration skeleton, persistence, WS and real validation all work. But the pipeline **reports success when every Bob task has failed**. That breaks the project's own "evidence over claims" principle.

## 4. Classification

### A. Fully implemented and working
- Mission CRUD, the approval gate (DB-polled), the double-start guard
- SQLite schema and parameterised queries throughout
- WS EventBus with per-mission filtering; the frontend WS hook with auto-reconnect
- **Validation executor**: real `npm` commands, verbatim stdout/stderr, exit code and duration persisted to `validation_runs`
- Prompt capture as evidence
- Frontend layout: sidebar, pipeline stepper, parallel grid, timeline, evidence drawer, change-plan panel, new-mission modal with two quick-load scenarios. It builds and typechecks.
- demo-app: 10 documented seeded issues (all verified present in source), 29 passing tests
- `.bob/rules/forgeguard.md` (12 rules) and 7 skills with front-matter

### B. Partially implemented
- `BobShellClient`: its structure is sound (no shell, args array, timeout), but it **can't spawn on Windows** and uses **flags that Bob 2.0.5 doesn't have** (`--chat-mode`, `--auth-method`, `--hide-intermediary-output`, `--approval-mode`). The code comment saying "unknown flags are ignored gracefully" is false (#18).
- Streaming: `onChunk` is supported in the client, but the orchestrator never passes it, so `agent.output` never fires and the "Bob output (streaming)" panel is dead.
- Rollback: it exists, but the design is wrong (see §6).
- Release report: the prompt exists, but the verdict isn't derived from validation data.
- Skills: `.bob/skills` exist, but the runtime prompts don't reference them. The prompts are inlined in `prompts.ts`.
- Evidence Drawer: works, but the header count stays at 0 until the drawer is opened (evidence is only fetched on open).

### C. Stubs
- `BobApiClient`: returns an explicit "not yet implemented" failure. That's honest and fine as-is.
- `artifacts` table and `agent_tasks.structured_output`: never written. **No diff of implementation changes is captured anywhere.**
- `failPhase()`: defined, never called.
- `demo-app` `dev` script uses `ts-node-esm`, which isn't installed.

### D. Broken
1. Bob never executes on Windows (ENOENT), and never would on any OS (unknown flags).
2. Phases are marked `completed` regardless of task success. The mission ends `complete`.
3. `npm start` crashes (schema.sql isn't copied to `dist`).
4. `verify-db.js` crashes.
5. The demo-app `typecheck`/`build`/`lint` fail on config, so validation is permanently red.
6. Frontend `npm run lint`: no ESLint config.
7. `completePhase` double-encodes string output (`JSON.stringify` on an already-serialised string).
8. On re-run, new phase rows are appended, but the UI uses `phases.find(...)` over `ORDER BY started_at ASC`. That shows the **oldest** (stale) phase state.
9. If the server restarts mid-mission, the mission is stuck forever: the statuses are "non-startable" and there's no resume or cancel. The header comment claims pipelines "survive restarts"; they don't.

### E. Simulated or fabricated states
- `releaseReadiness ?? 'conditional'` and `summary ?? 'Pipeline completed.'` are shown to the user as a verdict when no report exists.
- The phase "completed" status and duration represent failed spawns.
- The release-report prompt template contains `"validationPassed": true`, which biases the model toward a false claim.
- The UI label "5 Bob subagents" is inaccurate. They are 5 **independent `bob` CLI processes** started with `Promise.all`, not Bob's native subagent mechanism (`spawn_subagent`).
- The docs describe pipeline phases as "(future Milestone 2)" while the README describes them as working. Both are wrong in different directions.

## 5. Security findings

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | **High** | `repoPath` in `POST /api/missions` is unvalidated. The pipeline then runs `npm run lint/test/typecheck` (which executes that directory's `package.json` scripts) **and** a write-enabled Bob agent in any directory the caller names. That amounts to code execution by anyone who can reach the API. | `missions.ts:33`, verified live with `C:/Windows` |
| S2 | **High** | The server listens on all interfaces (`server.listen(PORT)`) with no auth. That makes S1 reachable from the LAN. CORS doesn't protect against non-browser clients. | `server.ts:46` |
| S3 | Medium | WebSocket has no `Origin` check. Any website the developer visits can open `ws://localhost:3001/ws` and read every mission's events (cross-site WebSocket hijacking). | `EventBus.ts` |
| S4 | Medium | Untrusted issue text is passed to a write-enabled agent (prompt injection). The user-level Bob settings (`~/.bob/settings/settings.json`) have `outsideWorkspaceAllowed: true` and edit enabled outside the workspace, and they allow `execute`. Read-only phases don't disable tool groups, even though `bob run --disable-tool-groups` exists. | settings.json, `bob run --help` |
| S5 | Medium (latent) | The obvious Windows fix (`shell: true` for `bob.cmd`) would turn the prompt, which contains issue text, into **command injection** via `cmd.exe` metacharacters. The fix must invoke Bob's Node entry point directly, without a shell. | §2 #19–20 |
| S6 | Low | `updateMissionStatus(extra)` interpolates object keys into SQL. All current callers pass none, but it's a foot-gun. | `PhaseRunner.ts:117` |
| S7 | Low | No length limit on `issueText` (2 MB body). It's stored and fanned out to 9 Bob invocations. | `missions.ts` |
| OK | — | All SQL is parameterised. Validation and git commands are constants, not built from input. No secrets reach the frontend. `.env` is git-ignored. The Bob child gets `process.env` (required for its key). | |

## 6. Rollback defects (by code inspection plus the live run)

1. **No git repo:** `stash` fails, `rollback_ref` stays null, and implementation proceeds anyway with **no rollback anchor**. This violates Bob rule #11.
2. **Inverted semantics:** `git stash push -u` *removes* the developer's uncommitted work before Bob runs. "Rollback" = `git stash pop`, which re-applies the developer's work **on top of** Bob's changes. Bob's changes are never reverted, and pop conflicts are likely.
3. **Clean tree:** `git stash push` exits 0 with "No local changes to save" and creates **no** stash, yet `rollback_ref` is recorded. A later pop then pops an **unrelated older stash**, or fails.
4. **Concurrent or repeated missions:** `pop` takes the top of the LIFO stack, not the mission's named stash. So mission A's rollback can restore mission B's anchor.
5. Rollback is allowed in any state (even mid-implementation). It emits no `rollback.completed` event, and the UI has no rollback button.
6. Git-ignored files are not protected (`-u` excludes ignored files).

**Safer design (for approval):** before implementation, record `HEAD` plus a snapshot commit of the full working tree made with `git stash create` / `git stash store` (doesn't touch the tree), or a copy of the tracked+untracked file list. Leave the developer's tree in place. Roll back by restoring exactly that snapshot (`git checkout <snap> -- .` plus removing files created after it). Refuse to implement when no anchor could be created. Lock rollback to one mission per repo at a time.

## 7. Critical blockers for the demo, in order

1. **Bob cannot be invoked** (spawn on Windows plus wrong CLI flags). Even after fixing it, **Bob credits are exhausted**: `~/.bob/db/bob.db` shows the last task ended with `BudgetExceededError … 40 Bobcoins`. A live Bob-backed run therefore isn't possible right now. The pipeline must report this **honestly as failed/unavailable**, never as completed.
2. **False-success reporting** (§4 D2, E).
3. **The demo-app baseline is red** for non-seeded reasons (typecheck/lint config).
4. **No rollback anchor**, because the demo-app isn't a git repo.
5. The frontend doesn't display the release report, validation results, errors or a rollback control. The demo can't show its core output.

## 8. Recommended fix order (small, verified milestones)

1. **Truthful pipeline state.** A failed Bob task fails its phase (`failPhase`). A failed required phase fails the mission with a clear reason. Record errors as `error` evidence. Remove the hardcoded readiness/summary defaults. Emit `agent.*` and `evidence.created`.
2. **Correct Bob invocation.** Use `bob run --mode <ask|plan|agent> -w <repo> --max-turns N -f json <prompt>`, spawning Bob's Node entry point directly (no shell, per S5). Use `--disable-tool-groups edit,…` for read-only phases. Capture Bob's real task ID when `-f json` provides one. Make `/api/health/bob` accurate. Add a pre-flight check so a mission fails fast with "Bob unavailable" instead of running 9 doomed tasks.
3. **Deterministic release verdict** computed from `validation_runs` (plus a baseline run before implementation, so pre-existing failures are distinguished from regressions). Bob's report becomes an optional narrative, clearly labelled as such.
4. **Demo-app tooling fixes** (tsconfig `rootDir`, ESLint Node globals) **without touching the seeded issues**. Initialise `demo-app` as a git repo with a baseline commit.
5. **Rollback redesign** per §6. Add tests with a temp git repo covering untracked, staged, dirty, clean and concurrent cases.
6. **Security:** allow-list `repoPath` (default `demo-app` only, or `FORGEGUARD_ALLOWED_REPOS`), bind to `127.0.0.1`, check WS `Origin`, cap `issueText`, remove the dynamic-key SQL.
7. **Build/run hygiene:** copy `schema.sql` into `dist`, fix `verify-db.js`, add a frontend ESLint config, add backend Vitest tests for the orchestrator (fake BobClient **only in tests**), StreamParser, rollback and routes. Add restart recovery (mark orphaned in-flight missions `failed: server restarted`).
8. **UI:** release report and validation-runs panel, error banner, rollback button, latest-phase selection, evidence count, a "Bob unavailable" state, and an accurate label ("5 parallel Bob sessions").
9. **Docs:** ARCHITECTURE, BOB_WORKFLOW (accurate Bob-in-development history from `bob.db`), DEMO_RUNBOOK, HACKATHON_EVIDENCE.

## 9. Bob development evidence found (read-only, for HACKATHON_EVIDENCE.md)

`~/.bob/db/bob.db` (Bob Shell's local task store) contains 6 tasks and 540 messages:
- the planning task (produced `IMPLEMENTATION_PLAN.md` / `BOB_WORKFLOW.md`), which hit the 100-turn limit
- **one native Bob subagent** (`task_type = subagent`, parent = the planning task): a workspace-exploration subagent
- the "Continue" implementation task (235 messages), which hit the 100-turn limit
- the report task, which stopped with `BudgetExceededError — 40 Bobcoins`

Tool names that appear in the message log: `read_file`, `write_file`, `apply_diff`, `execute_command`, `list_files`, `glob`, `grep`, `update_todo_list`, `search_ibm_docs`, `use_skill`, `spawn_subagent`, `switch_mode`. These are token occurrences, not exact call counts. Shell logs in `~/.bob/logs/shell/` show an earlier `Auth failure` against `/profile`.


---

# Milestone 1 + 2 Results — Truthful pipeline state & correct Bob Shell launch

**Date:** 2026-09-26 · **Engineer:** Claude Code (Opus 5.5). IBM Bob was **not** used for this milestone and no Bob task was run. Bob credits are exhausted.

> **Status in one line:** the integration code is corrected and availability detection works against the real Bob 2.0.5 install. **No real Bob task was executed**, so end-to-end Bob execution is still **unverified**.

## 1. Files changed

The original backend `src/` was copied before editing, so every change can be diffed. Nothing outside `backend/` was modified except this document.

| File | Change |
|---|---|
| `backend/src/bob/resolveBob.ts` | **new**: locates Bob and resolves the npm wrapper to `node + bobshell/dist/bob.js` |
| `backend/src/bob/redact.ts` | **new**: redacts values of secret-named env vars (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`) |
| `backend/src/bob/BobShellClient.ts` | rewritten: `bob run` syntax, `shell: false`, stream-json parsing, strict success rule, real `checkAvailability()` |
| `backend/src/bob/BobClient.ts` | modes limited to `ask`/`plan`/`agent`; new `BobErrorKind` and `BobInvocation`; diagnostic fields on result/status |
| `backend/src/bob/BobApiClient.ts` | still an honest stub; failures now tagged `BOB_UNAVAILABLE` / `not_implemented` |
| `backend/src/bob/StreamParser.ts` | added `BobStreamJsonParser` and `extractLastJsonBlock` (existing functions kept) |
| `backend/src/bob/TaskManager.ts` | persists full diagnostics; `error` evidence on failure; `structured_output` populated; emits `agent.*` / `evidence.created` |
| `backend/src/pipeline/MissionOrchestrator.ts` | phase wrapper that completes a phase only on success; failure propagation; no default verdict; `startMission()` preflight |
| `backend/src/pipeline/PhaseRunner.ts` | `PHASE_ORDER`, `skipRemainingPhases()`, `failMission()`; stopped double-encoding phase output |
| `backend/src/pipeline/prompts.ts` | release template no longer suggests `"validationPassed": true` |
| `backend/src/routes/missions.ts` | `/start` now delegates to `startMission()` (preflight + 503) |
| `backend/src/routes/health.ts` | `/api/health/bob` returns the full diagnostic, with HTTP 503 when unavailable |
| `backend/src/ws/EventBus.ts` | added `emitEvent()` (a no-op when the bus isn't running) |
| `backend/src/ws/events.ts` | `mission.completed` payload now carries the `validation` evidence |
| `backend/tests/*.test.ts`, `backend/tests/fixtures/fake-bob.mjs` | **new** tests (section 8); the fixture is test-only |

Not touched: the frontend, the demo-app (seeded bugs intact), `.bob/` rules and skills, Bob's own `~/.bob` data, the rollback mechanism, and the DB schema (no new tables or columns).

## 2. Bob installation discovered (safe inspection only)

- **Version:** `bob --version` → `2.0.5` (commit `2dc180906`). npm package `bobshell@2.0.5`, `"type": "module"`, `"engines": {"node": ">=22"}`
- **Wrappers:** `%USERPROFILE%\AppData\Roaming\npm\bob` (sh), `bob.cmd` (cmd), `bob.ps1`. `where bob` lists `bob` and `bob.cmd`. Both wrappers just run `node "%dp0%\node_modules\bobshell\dist\bob.js" %*`.
- **Entry point:** `%USERPROFILE%\AppData\Roaming\npm\node_modules\bobshell\dist\bob.js`
- **Node:** v22.20.0 (`C:\Program Files\nodejs\node.exe`), which meets Bob's `>=22`.

## 3. Correct invocation syntax (from `bob run --help` and the bundle's option parser)

```
bob run --mode <ask|plan|agent> -w <workspace> --max-turns <n> -f stream-json
        [--disable-tool-groups edit,execute,mode,artifact] -- <prompt>
```

- Top-level `bob` has no `--chat-mode`, `--auth-method`, `--approval-mode` or `--hide-intermediary-output`. Passing them gives `unknown option` (verified in the audit).
- Built-in mode ids in the bundle: `ask` (read, browser, mcp, skill, subagent), `plan` (adds edit, todo, mode), `agent` (adds execute, artifact).
- In the bundle source, `-f stream-json` writes NDJSON: `message` (assistant deltas; `isReasoning` flag), `tool_use`, `tool_result`, `error` (for example, max turns or max cost), and a final `result` with `stats.task_id`. **This event format was read from the bundle source, not from a live run.**
- Auth: the bundle reads `BOBSHELL_API_KEY` (or Bob's stored login). ForgeGuard never puts the key in argv or evidence.

## 4. Windows process execution

- `resolveBobLaunch()` searches, in order: `BOB_CLI_PATH`, then `PATH` (`bob.cmd`/`bob.exe`/`bob.ps1`/`bob`), then `%APPDATA%\npm`. For an npm wrapper it uses the sibling `node_modules\bobshell\dist\bob.js`. On POSIX it follows the bin symlink.
- The spawn is `spawn(process.execPath, [entryPoint, 'run', '--mode', m, '-w', ws, '--max-turns', n, '-f', 'stream-json', ..., '--', prompt], { shell: false, windowsHide: true })`.
- A `.cmd`/`.ps1` wrapper is **never** executed, and a `.cmd` whose entry point can't be found is refused.
- The prompt, which contains issue text, is one argv element after `--`. It can't become a shell command or a Bob option.
- `--disable-tool-groups edit,execute,mode,artifact` is passed to every read-only task (phases 1, 2, 3, 6), so they have no write or exec tools. Phase 4 (`agent`) keeps its full tool set; whether edits get auto-approved is up to the user's Bob settings (**unverified headless**).
- The validation runner still uses `shell: true` on Windows for its **constant** `npm` commands. No input reaches it. That was left as-is.

## 5. Failure propagation through phases

- Every phase runs through `MissionOrchestrator.phase()`. `completePhase()` is called only if the work returns `ok`. A returned failure **or a thrown exception** calls `failPhase()` and raises `PhaseFailure`.
- A Bob task succeeds only if **exit code 0, a `result` event with `status: "success"`, no `error` event, and (for phases 1/2/3/6) a parseable `FORGEGUARD:JSON` block** are all present. Otherwise it gets one of: `unavailable`, `spawn_failed`, `timeout`, `nonzero_exit`, `bob_error`, `no_result`, `not_implemented`.
- Phase 2 fails if **any** of the 5 specialists fails; the error names which ones. Phase 3 fails unless the plan has a `summary` and at least one step, so an empty plan can no longer reach approval. Phase 5 fails if any command exits non-zero or none ran. Phase 6 fails unless `releaseReadiness` is a valid value *and* is consistent with this run's stored `validation_runs` rows (`deriveReleaseReadiness`). It never falls back to a default.
- After a failure, the later phases are inserted as `skipped` with `error_message = "Blocked: phase "X" failed"`. They are never executed.

## 6. Mission state on failure

- `failMission()` sets `status='failed'` and an `error_message` such as `Phase "repo_understanding" failed: repo_understander [bob_error] Bob reported an error: ...`. It emits `mission.updated` (failed) and `mission.failed`.
- `complete` and `mission.completed` happen **only** after all 6 phases complete. The payload's `releaseReadiness` comes from the validated report, and the payload includes the validation commands and exit codes. The hardcoded `'conditional'` and `'Pipeline completed.'` are gone.
- Preflight: `POST /start` runs `checkAvailability()` first. If Bob is unavailable it returns **HTTP 503 `{code:'BOB_UNAVAILABLE'}`**, and the mission becomes `failed` with a `BOB_UNAVAILABLE: ...` message. **No phases or agent tasks are created.** One `error` evidence row (`phase_name='preflight'`) is written.
- Status is re-checked after the async preflight, to block concurrent double starts. A re-run resets `plan_approved`, so an old approval can't auto-approve a new plan (this was a latent bug). Approval timeout and cancellation also fail the mission and block the remaining phases.
- A mission waiting at approval stays `awaiting_approval`. "Blocked" is represented by `skipped` phase rows, because the mission status CHECK constraint was deliberately left unchanged.

## 7. Evidence recording (per Bob task)

- The `agent_tasks` row stores status (`completed` / `failed` / `timed_out`), `raw_response` (full redacted stdout), `structured_output` (the parsed JSON block), `duration_ms`, `error_message` and timestamps.
- Evidence rows:
  - `prompt`
  - `response` (the assistant text)
  - `structured_output`
  - one diagnostic row: `observation` on success, **`error` on failure**. It is JSON with provider, ForgeGuard task ID, **Bob task ID** (from `result.stats.task_id`), `errorKind`, error, **exit code**, `startedAt`, `completedAt`, **duration**, invocation (command, entry point, args with the prompt replaced by `<prompt: N chars ...>`, workspace, mode), **stdout** and **stderr**.
- Redaction runs in `BobShellClient` and again in `TaskManager` before anything is persisted or broadcast.
- `agent.output` is emitted only for assistant text actually parsed from Bob's stream-json. There are no timers and no synthetic events.
- If no rollback anchor is created, an `observation` evidence row says so. The rollback mechanism itself is unchanged.

## 8. Tests added (`backend/tests`, Vitest): 36 tests

- `resolveBob.test.ts` (7):
  - Windows wrapper resolves to node + entry
  - `.cmd` without an entry point is refused
  - `BOB_CLI_PATH` `.js` is honoured; missing path and not-found are reported
  - POSIX symlink is followed
  - **the real local install** resolves to `bobshell\dist\bob.js` (skipped on machines without Bob)
- `BobShellClient.test.ts` (16), using `tests/fixtures/fake-bob.mjs` (a test-only stand-in entry point spawned through the real code path):
  - exact argv shape and no `--chat-mode`
  - read-only tool groups
  - **shell metacharacter prompt arrives as one literal argv element, and no injected file is created**
  - a leading `--yolo` stays inside the prompt
  - stream-json parsing (reasoning excluded, Bob task ID captured)
  - classification of `bob_error`, error-event-with-exit-0, `nonzero_exit`, `no_result` and `timeout`
  - unavailable without spawning
  - **secret redaction** in output/stdout/stderr
  - availability: OK, missing `run` flags, CLI missing
- `pipeline.test.ts` (13), using an in-test `FakeBobClient` and in-memory SQLite:
  - full success → all phases completed
  - Phase 1 failure → Phase 2 not executed, rest skipped, mission failed, error evidence with exit code and duration, correct events
  - missing JSON block fails the phase
  - specialist failure → no plan
  - malformed plan → no approval
  - implementation failure → validation never runs
  - validation failure → no report, mission failed
  - **report without verdict → no `mission.completed`, no `"conditional"`**
  - `deriveReleaseReadiness` never invents a verdict
  - **Bob unavailable → 503, zero phases/tasks**
  - 409 while in progress
  - re-run resets approval
  - **API key never stored**

**Mutation checks (to prove the tests bite):**
- Re-introducing "complete the phase even on failure" made **7 tests fail**.
- Switching the Bob spawn to `shell: true` made the injection test **fail**.
- Both files were restored afterwards.
- One side effect of the `shell: true` mutation: cmd.exe may have run the injected commands inside the test's temp directory. I confirmed no Calculator process was running afterwards, and the payload was then changed to harmless marker commands only.

The fakes exist only under `backend/tests/` and can't be reached from the application.

## 9. Verification commands executed (2026-09-26)

| Dir | Command | Exit | Result |
|---|---|---|---|
| backend | `npm run typecheck` | 0 | clean |
| backend | `npm run build` | 0 | clean |
| backend | `npm test` | 0 | **3 files, 36/36 passed** |
| frontend | `npm run typecheck` | 0 | clean (frontend unchanged) |
| frontend | `npm run build` | 0 | built |
| demo-app | `npm test` | 0 | **29/29 passed** (seeded bugs untouched) |
| backend | `npm run dev` + `GET /api/health/bob` (real install) | HTTP 200 | `available:true`, `version:"2.0.5"`, `command:"C:\Program Files\nodejs\node.exe"`, `entryPoint:"...\npm\node_modules\bobshell\dist\bob.js"`, `resolvedVia:"PATH (...\bob.cmd) (npm wrapper → bobshell entry point)"`, `runSyntax.supported:true` |
| backend | `npm run dev` with `BOB_CLI_PATH=C:\nonexistent\bob.js`: `GET /api/health/bob` | HTTP 503 | `code: BOB_UNAVAILABLE` |
| backend | same server: create mission → `POST /start` | HTTP 503 | `{code:"BOB_UNAVAILABLE", ...}`; mission `failed`; **phases `[]`, tasks `[]`**; evidence `error/preflight` |
| bobshell | `node dist/bob.js --version`, `bob run --help` | 0 | 2.0.5 and flag list (no prompt sent) |

**Not run, deliberately:** `POST /start` against the real Bob installation. With the launch fixed and `available: true`, that **would start real, paid Bob tasks**.

## 10. Remaining blockers

1. **Real Bob execution is unverified.** Credits are exhausted (`BudgetExceededError — 40 Bobcoins` in `~/.bob/db/bob.db`). The stream-json event shapes, `--disable-tool-groups` behaviour, headless edit auto-approval in `agent` mode, and whether headless mode needs `--trust` or license acceptance for this workspace have all been checked **against the bundle source only**. If credits return, the first real run will show whether they hold. Expected behaviour now: a budget or auth failure surfaces as a `failed` task, phase and mission, with Bob's error message as evidence.
2. **Pressing "Run Pipeline" now really invokes Bob.** The preflight passes on this machine, so a start would launch paid tasks, which will probably fail on budget. There's no "dry run" or kill switch; `BOB_CLI_PATH` pointing at a missing file acts as one.
3. The demo-app `lint`/`typecheck` config faults (section 2, #13 and #15) still exist. Validation, and therefore the mission, **will always fail at Phase 5** until Milestone 4.
4. The UI doesn't show `error_message`, `skipped` phases, the 503 reason or the release verdict. On a re-run, `phases.find()` still shows the oldest phase rows. This is UI milestone work.
5. The rollback defects (section 6 of the audit) are unchanged. Implementation still proceeds without an anchor; that's now recorded as evidence.
6. `npm start` from `dist` still crashes (`schema.sql` isn't copied), and `verify-db.js` is still broken.
7. Pipeline state is in-process. A server restart leaves in-flight missions stuck.
8. The `.env.example` keys `BOB_APPROVAL_MODE` and the `--approval-mode` comments are now unused or stale.
9. The security items S1–S4 and S6–S7 from the audit's section 5 are still open (S5 is resolved by this milestone).


---

# Milestone 3 + 4 Results — Deterministic release verdict & demo-app baseline

**Date:** 2026-09-26 · **Engineer:** Claude Code (Opus 5.5). **No Bob task was run and no Bob credits were used.** Every Bob interaction in the tests goes through in-test fakes under `backend/tests/`, which the application can't reach. No real mission was started.

> **Status in one line:** the release verdict is now computed by code from baseline and post-implementation `validation_runs` rows, and Bob's report can't change it. The demo-app toolchain is green, and the demo-app is a git repo with the baseline commit `fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f`.

## 1. Files changed

**Backend (Milestone 3)**

| File | Change |
|---|---|
| `backend/src/pipeline/releaseVerdict.ts` | **new**. Contains: <br>• the validation policy (`REQUIRED_VALIDATION_COMMANDS`) <br>• row checks <br>• per-command classification <br>• `computeReleaseVerdict` <br>• `reconcileBobAssessment` <br>• `loadReleaseVerdict` (reads DB rows) |
| `backend/src/pipeline/MissionOrchestrator.ts` | • A baseline suite runs at the start of Phase 4, before Bob. <br>• Phase 5 runs the post suite, then computes the verdict from the DB. <br>• Phase 6 is narrative plus reconciliation. <br>• Execution is split from persistence: `executeCommand` + `recordValidationRun`, with a test-only `executeValidationCommand` hook replacing `runValidation`. <br>• `deriveReleaseReadiness` was removed (superseded). |
| `backend/src/pipeline/prompts.ts` | The release prompt now gets the baseline/post comparison and the verdict. It's told its report is narrative, and its enum is `ready`, `conditional` or `blocked`. |
| `backend/src/db/schema.sql` | `validation_runs.run_kind` (`baseline`/`post`, default `post`) |
| `backend/src/db/database.ts` | `migrate()`: adds `run_kind` to existing databases |
| `backend/src/routes/missions.ts` | `GET /api/missions/:id/release-verdict` (recomputed from rows) |
| `backend/src/ws/events.ts` | `validation.*` payloads carry `kind`. `mission.completed` carries: <br>• the deterministic `releaseReadiness` (`ready` or `conditional`) <br>• `verdictReasons`, `bobAssessment`, `discrepancy` <br>• per-command classification |
| `backend/package.json` | `test` excludes `*.integration.test.ts`; new `test:integration` script |
| `backend/tests/releaseVerdict.test.ts` | **new**, 14 tests |
| `backend/tests/pipeline.test.ts` | Moved to the new executor hook. The `deriveReleaseReadiness` test was replaced, and 6 baseline/verdict tests were added (18 total). |
| `backend/tests/database.test.ts` | **new**, migration of a legacy database |
| `backend/tests/validation.integration.test.ts` | **new**. Runs the real `npm` commands in demo-app and persists real rows. |

**Demo-app (Milestone 4)**

| File | Change |
|---|---|
| `tsconfig.json`, **new** `tsconfig.build.json` | split into type-check and build configs |
| `eslint.config.js` | typescript-eslint `eslint-recommended` override; ignores |
| `package.json` | `build` and `dev` scripts |
| **new** `.gitignore` | ignore rules for the new repo |
| deleted | 12 stale tsc artifacts in `tests/`, and the old `dist/` |

**Docs:** new `docs/RELEASE_VERDICT.md` and `docs/DEMO_BASELINE.md`, plus this section.

## 2. Deterministic verdict algorithm

The full specification is in `docs/RELEASE_VERDICT.md`. Each required command is classified from its baseline result (B) and post result (P):

| B → P | Classification |
|---|---|
| pass → pass | `pass` |
| fail → pass | `fixed` |
| missing → pass | `pass_without_baseline` |
| fail → fail | `preexisting_failure` |
| pass → fail | **`regression`** |
| missing → fail | `unclassified_failure` |
| any → missing | `missing_post` |

The verdict rules are applied in order:

1. Any malformed row → **no verdict** (`null`).
2. Implementation failed or was skipped → **blocked**.
3. Zero rows → **no verdict**.
4. Any regression, unclassified failure or missing post result → **blocked**.
5. Any pre-existing failure, missing baseline or unknown implementation outcome → **conditional**.
6. Otherwise → **ready**.

A **malformed** row is one that:

- never completed
- has an exit code that isn't an integer
- has `passed` that isn't 0 or 1, or that contradicts the exit code
- has the wrong `run_kind`
- has an empty command
- duplicates another command in the same bucket

How the verdict drives the mission:

- **blocked** or **no verdict**: Phase 5 fails (`Release blocked: …` or `No release verdict: …`), Phase 6 is skipped, and the mission is `failed`.
- **ready** or **conditional**: Phase 5 completes, Bob writes the narrative, and the mission is `complete` with the deterministic value.
- **Bob disagrees**: the deterministic value stands, and the disagreement is stored in `release_report.discrepancy`, the `mission.completed` payload and an evidence row.

## 3. Baseline/post-validation model

- **Storage:** the existing `validation_runs` table plus **one** new column, `run_kind`. The phase ID alone couldn't reliably tell baseline from post, so the column was needed. No other schema change was made; the mission status CHECK is unchanged.
- **Baseline rows:** `phase_id` is the implementation phase. They are written **before** the implementer task starts; a test asserts this ordering.
- **Post rows:** `phase_id` is the validation phase.
- **Re-runs:** `loadReleaseVerdict` pairs the latest implementation phase with the validation phase that follows it, so rows from different runs never mix.
- **Commands:** the same four commands run in both suites (`npm run lint`, `npm test`, `npm run typecheck`, `npm run build`).
- **Stored per run:**
  - stdout and stderr (verbatim, redacted)
  - exit code
  - `passed`
  - `started_at` and `completed_at`
  - `duration_ms`
- **Baseline failures:** recorded, never fatal.

## 4. Exact demo-app configuration fixes

- **`tsconfig.json`**
  - Removed: `rootDir`, `outDir`, `declaration`, `declarationMap`, `sourceMap`.
  - Added: `noEmit: true`.
  - `include` still covers `src/**/*` and `tests/**/*`.
  - All strictness flags are unchanged.
- **`tsconfig.build.json`** (new): extends the above, with `noEmit: false`, `rootDir: ./src`, `outDir: ./dist`, declaration, declaration map and source map, and `include: ["src/**/*"]`.
- **`package.json`**
  - `"build": "tsc -p tsconfig.build.json"`
  - `"dev": "npm run build && node dist/server.js"` (was `ts-node-esm`, which isn't installed)
- **`eslint.config.js`**
  - Added `{ ignores: ['dist/**','coverage/**','node_modules/**'] }`.
  - Spread `tsPlugin.configs['eslint-recommended'].overrides[0].rules` into the TS block. This is typescript-eslint's documented adjustment: it turns off `no-undef` and similar rules that the TS compiler already checks, and turns on `no-var`, `prefer-const` and similar rules.
  - No project rule was disabled, and no dependency was added.
- **Removed stale files:** `tests/*.test.{js,js.map,d.ts,d.ts.map}` were deleted. They were output of the earlier failing build, and they also caused 3 of the 6 lint errors.

## 5. Baseline git commit

`fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f` on `main` in `demo-app/` (an independent repo).

- 16 files tracked.
- `node_modules/`, `dist/`, coverage, `.env*` and logs are ignored.
- `git status` was clean after the commit, and still clean after two further real validation runs.
- The existing git identity was used; the git config was not modified.

## 6. Exact baseline validation results (committed state)

| Command | Exit | Duration | Output |
|---|---|---|---|
| `npm run lint` | 0 | 7646 ms | no problems |
| `npm test` | 0 | 4513 ms | `Test Files 3 passed (3)`, `Tests 29 passed (29)` |
| `npm run typecheck` | 0 | 4552 ms | clean |
| `npm run build` | 0 | 4050 ms | `dist/` emitted |

Through ForgeGuard's real executor (`npm run test:integration`), all 8 persisted rows had exit 0:

| Command | Baseline | Post |
|---|---|---|
| lint | 6880 ms | 6871 ms |
| test | 3938 ms | 3838 ms |
| typecheck | 3887 ms | 3821 ms |
| build | 3520 ms | 3729 ms |

The verdict was `ready` and the mission reached `complete`, using the no-op fake Bob.

The seeded issues are still present, verified live on the dev server:

- a discount rate of 150 gives a total of −54
- stock goes 8 → −92
- `<script>` is echoed back unchanged
- `formattedTotal` is `""`

## 7. Test counts and verification commands (2026-09-26)

| Dir | Command | Exit | Result |
|---|---|---|---|
| backend | `npm run typecheck` | 0 | clean |
| backend | `npm run build` | 0 | clean |
| backend | `npm test` | 0 | **5 files, 56/56 passed** (releaseVerdict 14, pipeline 18, BobShellClient 16, resolveBob 7, database 1). Was 36 before this milestone. |
| backend | `npm run test:integration` | 0 | **1/1 passed** (real commands, 36.6 s) |
| demo-app | `npm test` | 0 | **29/29 passed** |
| demo-app | `npm run typecheck` | 0 | clean |
| demo-app | `npm run lint` | 0 | 0 errors, 0 warnings |
| demo-app | `npm run build` | 0 | `dist/` emitted |
| demo-app | `git status` | — | clean; `git log`: `fc6794e Baseline: …` |

The required cases map to tests in `releaseVerdict.test.ts`, numbered 1–10:

1. green → green gives ready
2. unchanged baseline failure gives `preexisting_failure` / conditional
3. regression gives blocked
4. missing post gives blocked
5. missing baseline gives unclassified (blocked) or `pass_without_baseline` (conditional)
6. Bob says ready while validation fails: validation wins
7. Bob says blocked while green: discrepancy preserved
8. zero runs gives no verdict
9. malformed rows (6 kinds plus duplicates) give no verdict
10. failed implementation gives blocked

Cases 6 and 7 are also covered end-to-end in `pipeline.test.ts`.

**Mutation checks:** each mutation was applied temporarily and the files were then restored; the suite went back to 57/57 including the integration test.

| Mutation | Tests failed |
|---|---|
| Regressions treated as pre-existing | 4 |
| Zero-evidence guard removed | 2 |
| Mission verdict hardcoded to `"ready"` | 2 |

## 8. Remaining blockers

1. **Real Bob execution is still unverified.** Credits are exhausted. Any real start would now also spend about 40 s on baseline validation after approval.
2. **Rollback (next milestone).** The demo-app is now a git repo, so the old `git stash push -u` anchor will actually run.
   - On the **clean** baseline tree it prints "No local changes to save" but still records `rollback_ref` (audit §6 defect 3).
   - Even when a stash is created, the old mechanism rolls back the wrong thing (§6 defect 2).
   - This is **more** reachable now than before. It must be redesigned before any real implementation run.
3. **A Bob report failure fails the mission, even with a ready or conditional verdict.** This keeps the Milestone 1+2 rule "a failed phase fails the mission". The verdict itself is still persisted and served by `/release-verdict`. Whether a narrative failure should downgrade a mission is a product decision.
4. **`npm run build` is part of the policy.** A target repo with no `build` script fails that command in both runs, so it can only reach `conditional`. That's correct under "no evidence, no claim", but worth knowing.
5. **Validation commands have no timeout.** A hanging `npm` script would stall the phase. The runner still uses `shell: true` on Windows, for its fixed constant commands only.
6. **The UI doesn't show** the verdict, the baseline/post table or discrepancies. `frontend/` was not touched.
7. Milestone 1+2 blockers 4–9 are otherwise unchanged:
   - `npm start` `schema.sql` copy
   - `verify-db.js`
   - restart recovery
   - stale `.env.example` keys
   - security items S1–S4, S6 and S7

## 9. Intentionally left untouched

- All 10 seeded demo-app issues
- All demo-app test files and all `src/` files
- Compiler strictness
- The rollback mechanism
- The security items
- `frontend/`
- `.bob/` rules and skills
- `~/.bob`
- The mission status CHECK constraint
- The Bob invocation code from Milestone 2


---

## Milestone 5 + Security Results

**Date:** 2026-09-26 · **Engineer:** Claude Code (Opus 5.5).

**No Bob task was run and no Bob credits were used.** Bob appears only as the test-only `FakeBobClient` (`backend/tests/helpers/fakeBob.ts`). During the live check, `/start` was deliberately **not** called.

Detailed design:

- [ROLLBACK_DESIGN.md](ROLLBACK_DESIGN.md)
- [SECURITY_MODEL.md](SECURITY_MODEL.md)
- [VALIDATION_POLICY.md](VALIDATION_POLICY.md)
- [RELEASE_VERDICT.md](RELEASE_VERDICT.md) (updated)

### 1. Files changed

**New (backend):**

| File | Purpose |
|---|---|
| `src/git/git.ts` | argv-only git runner (`shell: false`) |
| `src/git/snapshot.ts` | anchors, result snapshots, restore and verification |
| `src/git/repoLock.ts` | repository lock |
| `src/pipeline/rollback.ts` | mission rollback and its gates |
| `src/security/repoPolicy.ts` | repository allow-list |
| `src/config.ts` | host, origins, limits, timeout |
| `src/app.ts` | Express factory: Origin guard, CORS, body limit, JSON errors |

**Changed (backend):**

| File | Change |
|---|---|
| `src/pipeline/MissionOrchestrator.ts` | • New flow. <br>• Lock windows. <br>• Anchor before the implementer. <br>• Result snapshot. <br>• Timeout-aware `executeCommand` with process-tree kill. <br>• Preflight: `ROLLBACK_PENDING`, `REPO_NOT_ALLOWED`, `REPO_NOT_GIT`, `REPO_LOCKED`. <br>• The stash-based `createRollbackAnchor` was removed. |
| `src/pipeline/releaseVerdict.ts` | `timed_out` outcome and classification; baseline scoped to the `repo_understanding` phase |
| `src/pipeline/PhaseRunner.ts` | column allow-list in `updateMissionStatus` (S6) |
| `src/routes/missions.ts` | input limits and allow-list on create; rollback delegates to `rollbackMission` (the `git stash pop` shell spawn is gone) |
| `src/server.ts` | `startServer()`, bind to `FORGEGUARD_HOST` (default `127.0.0.1`) |
| `src/ws/EventBus.ts` | Origin check in `verifyClient` |
| `src/ws/events.ts` | `validation.completed` carries `timedOut`, and `exitCode` can be null |
| `src/bob/TaskManager.ts` | standalone `recordEvidence()` (redacting) |
| `src/db/schema.sql`, `src/db/database.ts` | `validation_runs.timed_out`, plus its migration |

**Tests (backend):**

- New: `tests/rollback.test.ts`, `tests/security.test.ts`, `tests/validationTimeout.test.ts`
- New helpers: `tests/helpers/gitRepo.ts`, `tests/helpers/fakeBob.ts`
- Updated: `pipeline.test.ts` (real temporary git repos, 7 new tests), `releaseVerdict.test.ts`, `database.test.ts`, `validation.integration.test.ts` (removes its own refs and asserts demo-app is untouched)

**Other:**

- `frontend/vite.config.ts`: the proxy now targets `127.0.0.1:3001`. Config only, no UI change.
- `.env.example`: the four `FORGEGUARD_*` settings.
- Docs: the three new documents, and updates to `RELEASE_VERDICT.md` and this file.

### 2. Rollback architecture

The flow is now:

1. Baseline validation (with the lock held), then a working-tree snapshot.
2. Bob analysis, change plan, approval.
3. **Lock, then anchor.** A failure here means Bob's implementer never starts.
4. Implementation.
5. Post-implementation validation.
6. Deterministic verdict.
7. Result snapshot, then the lock is released.

The anchor is two commits built with plumbing:

- **Index snapshot:** `write-tree` of a *copy* of `.git/index`.
- **Working-tree snapshot:** a temporary index seeded with the index tree, then `add --all` with `core.autocrlf=false`, then `write-tree`.
- The index commit's parent is HEAD, and the anchor commit's parent is the index commit.
- They're stored under a create-only ref, `refs/forgeguard/anchors/<missionId>/<8-hex>`, and recorded in `missions.rollback_ref`.

Neither the working tree nor the index is ever written, and no stash is used. A test asserts that files, `git status`, the index entries and the stash list are identical before and after anchor creation.

Rollback steps:

1. Check the gates.
2. Restore the index: `read-tree <index tree>`.
3. Diff the current snapshot against the anchor. Delete files added since the anchor; restore changed or deleted files with `git restore --source=<anchor> --worktree`, NUL-separated literal pathspecs and `autocrlf=false`. Repeat up to 3 passes, because restoring `.gitignore` can reveal hidden files.
4. Verify that both trees equal the anchor.
5. Mark the mission `rolled_back` and write evidence.

### 3. How developer changes are preserved

- The anchor captures the developer's state **as it was**: staged content (index tree) and on-disk content, including untracked and deleted files (work tree).
- Rollback restores both, so unstaged edits stay unstaged, staged edits stay staged (including `MM` partial staging), untracked files stay untracked, and deletions stay deleted. This holds even when Bob edited, deleted or recreated the same files. It's verified byte-for-byte, including CRLF and binary files.
- Changes made **after** the mission ended aren't discarded. Rollback compares the current state with the mission's result snapshot and refuses with `ROLLBACK_CONFLICT`, listing the changed paths.

### 4. How mission-specific anchors work

- **Anchor ref:** one unique ref per mission run. The anchor commit carries the trailers `ForgeGuard-Mission`, `-Head`, `-Branch` and `-Created`.
- **Ownership check:** rollback verifies both the ref prefix and the trailer, so a mission can't use another mission's anchor (`ANCHOR_MISMATCH`).
- **Result ref:** `refs/forgeguard/results/<missionId>/<tag>` pins the state the mission left.
- **Sequential missions A then B:**
  - A's rollback is refused while B's changes are present.
  - Rolling back B restores A's result.
  - Rolling back A after that restores the original state.
- **Other refusals:**
  - rollback after commits were made (`ROLLBACK_HEAD_MOVED`, no history rewriting)
  - repeated rollback (`ROLLBACK_ALREADY_DONE`)
  - non-terminal states (`ROLLBACK_NOT_ALLOWED`)
  - missions without an anchor (`NO_ROLLBACK_ANCHOR`)
  - unknown missions (404)
  - a re-run while an anchor is still pending (`ROLLBACK_PENDING`)

### 5. How repository locking works

- **Mechanism:** an `O_EXCL` lock file at `<git common dir>/forgeguard.lock` holding mission ID, purpose, PID, host and time. It works across processes and worktrees, and only its owner removes it.
- **Held during:**
  - baseline validation
  - anchor creation through the result snapshot (implementation plus post-implementation validation)
  - rollback
- **Not held** during Bob analysis or the approval wait. Tree changes during that window are caught by the baseline-tree check.
- **Stale locks:** a lock whose PID is dead on the same host is taken over, and the takeover is recorded as evidence.
- **Responses when the lock is held:**
  - `/start`: 409 `REPO_LOCKED`
  - a pipeline that reaches the lock: phase failure `REPO_LOCKED`
  - rollback: 409
- **Tested:** mission B, approved while mission A was implementing, failed with `Implementation not started: REPO_LOCKED`, and its implementer was never called.

### 6. Security controls implemented

| Brief item | Control |
|---|---|
| S1 | **Repository allow-list.** The default is demo-app only; `FORGEGUARD_ALLOWED_REPOS` replaces it. Paths are compared after `realpath` and must match exactly (no prefix check). Relative paths, traversal escapes and symlink/junction escapes are rejected with 403 `REPO_NOT_ALLOWED`, without echoing paths. It's enforced on create, re-checked at `/start` (catching legacy rows) and at rollback. The canonical path is what's stored. |
| S2 | **Loopback bind.** The default is `127.0.0.1`, overridable with `FORGEGUARD_HOST` (a non-default host logs a warning). Verified live: only `127.0.0.1:3001` is listening. |
| S3 | **Origin policy.** WebSocket: `verifyClient` answers 403 for unknown origins and `null`, accepts allow-listed ones, and accepts a missing Origin (non-browser tooling). REST: CORS allow-list, plus a server-side 403 `ORIGIN_NOT_ALLOWED` for state-changing requests from unknown origins. The allow-list comes from `FORGEGUARD_ALLOWED_ORIGINS`; `*` is never accepted. |
| S4 | **Input limits.** `issueText` is at most 12,000 characters (400 `ISSUE_TEXT_TOO_LONG`). The JSON body is at most 100 kB (413 `PAYLOAD_TOO_LARGE`). Invalid JSON gets 400 `INVALID_JSON`. |
| S6 | **No dynamic SQL keys.** `updateMissionStatus` accepts only allow-listed columns and throws before any SQL runs. |

### 7. Validation timeout behaviour

- **Setting:** `FORGEGUARD_VALIDATION_TIMEOUT_MS`, default **180000 ms**, per command.
- **Kill:**
  - Windows: `taskkill /T /F` on the whole tree (cmd → npm → node), using the absolute `System32` path.
  - POSIX: `SIGTERM`, then `SIGKILL`, to the process group.
  - After 5 s, ForgeGuard stops waiting for the pipes.
- **Stored row:** `timed_out=1`, `exit_code=NULL`, `passed=0`, the partial stdout and stderr, and the timestamps.
- **Evidence:** `validation_timeout`, with `timeoutMs`, the command, the output and the times.
- **Effect on the verdict:**
  - A **post** timeout is classified `timed_out`: blocked, Phase 5 fails, and no release report is requested.
  - A **baseline** timeout counts as missing baseline evidence, so the result can't be `ready`.
- **Fixed commands:** the commands are still constants; no input is interpolated into a shell.

### 8. Tests added

**`rollback.test.ts`** (18 tests, real git in temporary repositories):

| # | Case | Test |
|---|---|---|
| — | Anchor creation doesn't modify the working tree, index or stash | 1 |
| — | Unique refs per mission | 1 |
| 1, 6, 7, 8 | Clean repo; Bob creates, modifies and deletes files | 1 |
| 2, 9, 11 | Dirty tracked file that Bob edits too | 1 |
| 3 | Staged and partially staged changes | 1 |
| 4 | Untracked file | 1 |
| 5 | Unstaged and staged deletion | 1 |
| — | Exact CRLF and binary bytes | 1 |
| — | Ignored-file policy | 1 |
| — | File hidden by a `.gitignore` edit | 1 |
| 14 | Mission A vs B | 1 |
| — | Anchor mismatch | 1 |
| 15 | Repeated rollback | 1 |
| — | Post-mission developer edits | 1 |
| — | HEAD moved | 1 |
| — | Unknown mission, no anchor, non-terminal states | 1 |
| — | Lock held | 1 |
| — | Evidence | 1 |

Case 10 (restores the pre-implementation state) is asserted in every matrix test.

**`pipeline.test.ts`** (+7 tests):

- anchor created before the implementer, then a full rollback (with developer WIP and untracked notes) back to the exact prior state
- **12:** no valid anchor (unborn repository) → implementation refused
- not a Git repository (pipeline failure, and 422 from `/start`)
- tree changed between baseline and implementation → refused
- **13:** concurrent implementation blocked, and `/start` answers 409 `REPO_LOCKED`
- `ROLLBACK_PENDING` and `REPO_NOT_ALLOWED` at `/start`
- timeout fails Phase 5, with partial output kept and the evidence recorded

**`security.test.ts`** (15 tests; real HTTP server on an ephemeral loopback port, real `ws` clients):

1. outside the allow-list
2. traversal
3. symlink/junction escape, and the prefix-sibling trap
4. `issueText` too large (plus the body limit, invalid JSON and a non-string value)
5. unauthorised WebSocket origin (evil, `null`, wrong port)
6. allowed origins
7. host defaults (unit test and actual bound address)
8. SQL key injection

Also covered: the REST Origin guard and wildcard rejection.

**`validationTimeout.test.ts`** (4 tests, real processes):

- success
- failure
- timeout with partial stdout/stderr and a **grandchild PID confirmed dead**
- a pipeline run with the real executor where the post-implementation hang fails Phase 5

**`releaseVerdict.test.ts`** (+1): post timeout, baseline timeout, contradictory timeout row.

**`database.test.ts`**: also asserts the `timed_out` migration.

**Mutation checks.** Each mutation was applied temporarily, the relevant file was run, and the source was restored. Typecheck was clean afterwards.

| Mutation | Tests failed |
|---|---|
| M1: index not restored | 1 |
| M2: no post-mission conflict check | 2 |
| M3: untracked files not snapshotted | 9 |
| M4: lock not exclusive | 1 |
| M5: WebSocket origin not checked | 1 |
| M6: string-prefix repo check | 1 |
| M7: no process-tree kill | 2 |
| M8: default bind `0.0.0.0` | 2 |

M7 left orphaned `cmd.exe` and `node` processes, which is exactly the defect the tree kill prevents. They were found by command line and stopped, and the temp directories they held were removed.

### 9. Exact test results

| Dir | Command | Exit | Result |
|---|---|---|---|
| backend | `npm run typecheck` | 0 | clean |
| backend | `npm run build` | 0 | clean |
| backend | `npm test` | 0 | **8 files, 101/101 passed** in 71.8 s. Was 56. Per file: pipeline 25, rollback 18, BobShellClient 16, releaseVerdict 15, security 15, resolveBob 7, validationTimeout 4, database 1. |
| backend | `npm run test:integration` | 0 | **1/1 passed** (40.5 s, all 8 real demo-app runs exit 0, verdict `ready`, demo-app HEAD, tree and refs unchanged) |
| demo-app | `npm test` | 0 | 29/29 passed |
| demo-app | `npm run typecheck` | 0 | clean |
| demo-app | `npm run lint` | 0 | clean |
| demo-app | `npm run build` | 0 | built |
| frontend | `npm run typecheck` / `npm run build` | 0 / 0 | clean / built (after the proxy change) |

State of `demo-app` afterwards:

- `git log`: `fc6794e Baseline: …`
- `rev-parse HEAD` = `fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f`
- `git status --porcelain`: empty
- `refs/forgeguard/*`: none
- lock file: none
- stash: empty
- `git fsck`: exit 0

The integration run left dangling anchor objects, whose refs were deleted; normal git GC prunes them. All temporary test repositories were removed.

### 10. Exact commands executed (besides the test runs above)

- Timing probe: `git --version` ×20 took 43 ms average. An async `git()` call takes about 77 ms, so an anchor takes about 1 s.
- Live dev stack, with a throwaway `DB_PATH` in the session scratchpad, backend `npm run dev` and frontend `npx vite --port 5173`:

| Check | Result |
|---|---|
| `netstat -ano \| grep :3001` | only `127.0.0.1:3001 LISTENING` |
| `GET /api/health` through the Vite proxy | 200 |
| `POST /api/missions` through the proxy with the dev Origin | 201; `repo_path` is the canonical demo-app path |
| `POST /api/missions` with `repoPath: "C:/Windows"` | 403 `REPO_NOT_ALLOWED` |
| `POST /api/missions` with Origin `https://evil.example` | 403 `ORIGIN_NOT_ALLOWED` |
| `POST /api/missions` with 12,001 characters | 400 `ISSUE_TEXT_TOO_LONG` |
| `POST /:id/rollback` on a `created` mission | 409 `ROLLBACK_NOT_ALLOWED` |
| WebSocket through the proxy with the dev Origin | open |
| WebSocket direct with the evil Origin | 403 |
| WebSocket direct with no Origin | open |

  Rejections were logged as `[security] …` and `[ws] Rejected …`. Both servers (and the `ts-node-dev` parent) were stopped afterwards.
- `/start` was **not** called live.

### 11. Remaining blockers

1. **Real Bob execution is still unverified** (credits exhausted). Whether Bob's headless `agent` mode commits on its own is unknown. If it does, rollback correctly refuses with `ROLLBACK_HEAD_MOVED` instead of rewriting history. There's no "undo commits" path.
2. **Baseline position.** Baseline now runs at mission start, as the flow in the brief specifies. Any edit to the repository during analysis or the approval wait makes implementation refuse (`REPO_CHANGED_SINCE_BASELINE`), so the developer has to re-run. This is safe but strict.
3. **Pipeline and lock state are per process.** After a server crash, the lock file is detected as stale and taken over. But missions left in `implementing` or `validating` are still stuck (no restart recovery), and their anchors stay valid for manual rollback only after their status is terminal.
4. **Rollback limits:** nested repositories that Bob creates aren't removed; empty pre-existing directories may disappear; rollback isn't atomic under filesystem errors (the anchor and result refs are kept for recovery). See [ROLLBACK_DESIGN.md](ROLLBACK_DESIGN.md) §9.
5. **Test runtime.** Git-backed tests make `npm test` take about 72 s on this machine.
6. **Still open from the audit:**
   - prompt injection (audit S4) and the user-level Bob `outsideWorkspaceAllowed: true`
   - no authentication
   - `npm start` `schema.sql` copy and `verify-db.js`
   - stale `.env.example` Bob keys
7. **The UI doesn't show** the rollback button, the verdict, the `REPO_LOCKED` / `ROLLBACK_*` errors or the timeouts. That's UI milestone work, not started.


---

## Milestone 6 Results

**Date:** 2026-09-26 · **Engineer:** Claude Code (Opus 5.5).

**No Bob task was run and no Bob credits were used.** During the live verification the backend ran with `BOB_CLI_PATH=C:\nonexistent\bob.js`, the safe Bob-unavailable configuration, so "Run pipeline" could only reach the 503 preflight.

The design is described in [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md). The six-phase architecture and the database schema are unchanged.

### Files changed

**Frontend, new:**

| File | Purpose |
|---|---|
| `src/api.ts` | typed REST client that returns structured errors |
| `src/lib/selectors.ts` | pure display selectors |
| `src/components/ui.tsx` | panels, badges, collapsible output |
| `src/components/MissionHeader.tsx` | mission header |
| `src/components/FailurePanel.tsx` | failure details |
| `src/components/BobUnavailablePanel.tsx` | Bob-unavailable state |
| `src/components/ValidationPanel.tsx` | validation runs |
| `src/components/ReleasePanel.tsx` | deterministic decision and Bob analysis |
| `src/components/RollbackPanel.tsx` | rollback control |
| `src/components/AgentPanels.tsx` | parallel-analysis grid and live Bob output |
| `.eslintrc.cjs` | lint config (the `lint` script previously had none) |
| `vitest.config.ts` | test config |
| `src/test/fixtures.ts` | backend-shaped test fixtures |
| `src/lib/selectors.test.ts`, `src/components/dashboard.test.tsx` | tests |

**Frontend, rewritten:**

- `src/types.ts`
- `src/store/store.ts`
- `src/hooks/useWebSocket.ts`
- `src/App.tsx`
- `src/components/{Dashboard, PipelineStepper, ChangePlanPanel, EvidenceDrawer, ExecutionTimeline, Sidebar, NewMissionModal}.tsx`

**Frontend, removed:** `StatusBadge.tsx` and `ParallelAnalysisGrid.tsx` (superseded).

**Frontend, `package.json`:**

- New `test` script.
- New dev dependencies: `vitest@1.6.1` (the same version as the backend), `jsdom@24.1.3`, `@testing-library/react@14.3.1`.
- No runtime dependency was added.

**Backend (small additions the UI needs so React never decides anything):**

| File | Change |
|---|---|
| `src/pipeline/rollback.ts` | Gate evaluation refactored into `evaluateGates(check \| execute)`. New read-only `getRollbackStatus()`: no lock, no evidence, no working-tree changes. Rollback behaviour is unchanged. |
| `src/routes/missions.ts` | `GET /api/missions/:id/rollback-status`. Phases, tasks, evidence and validation runs are now returned in insertion order with `seq`. The old `ORDER BY started_at` put skipped rows, whose `started_at` is NULL, first. |
| `tests/rollback.test.ts` | +1 test: rollback status is read-only and matches the gates |

**Docs:** new `docs/UI_ARCHITECTURE.md`, and this section.

### UI capabilities added

1. **Mission header:** ID, status category (pending, running, awaiting approval, complete, failed, rolled back) together with the raw backend status, repository, current phase, created and updated times, full issue text, and the failure message.
2. **Pipeline stepper:** the newest row per phase; distinct pending, running, completed, failed and skipped states; "Blocked by: <phase>" on skipped phases.
3. **Failure panel:** phase, agent/task, task ID, classification (the backend code plus the Bob error kind), reason (paths shortened) and time.
4. **BOB UNAVAILABLE state:** provider, version, code, reason and time. Unsafe fields are dropped. It survives a reload, rebuilt from the preflight evidence.
5. **Validation panel:** BASELINE and POST-IMPLEMENTATION sections with command, kind, status, exit code (or "killed on timeout"), duration, start and end, and full stdout/stderr that can be expanded. Terminal colour codes are hidden for display only.
6. **Release decision:** READY / CONDITIONAL / BLOCKED / NO VERDICT, with the backend's reasons and per-command table.
7. **AI / BOB ANALYSIS:** a separate panel, with the backend's discrepancy note when Bob disagrees.
8. **Evidence drawer:** counts are correct immediately; tabs by type; agent name, ForgeGuard and Bob task IDs, status and timestamps.
9. **Live Bob output:** only from real `agent.output` events; otherwise "No live Bob output available."
10. **Rollback:** the button appears only when the backend reports rollback available, and needs confirmation. Otherwise the backend's reason is explained. After a rollback the result is shown and everything is refreshed.
11. **Approval panel:** summary, risk, files, risks and notes, testing, rollback plan, steps and approval state. Approval is gated on the backend state, and a backend refusal is displayed.
12. **WebSocket consistency:** events only trigger a debounced REST refresh; every (re)connect rehydrates; polling runs only while in progress or disconnected; the socket reconnects automatically.
13. **States:** loading, empty, success and failure (with Retry) for every panel; create-mission errors are shown in the modal.
14. **Presentation:** dark engineering UI with consistent status colours, ARIA roles and labels (dialogs, alerts, tabs, `aria-expanded`), Escape to close, and a responsive layout (verified at 390 px with no horizontal overflow). Bounce/pulse animations and emoji icons were removed.

### Tests added (frontend)

**`selectors.test.ts`** (12 tests): newest phase row after a re-run, backend `seq` precedence, blocked-by, error classification, path redaction, ANSI stripping, failure details, Bob diagnostics from evidence (no `node.exe` / entry-point leak), current-run validation, release-report parsing.

**`dashboard.test.tsx`** (14 tests):

1. A failed mission renders the error.
2. Skipped phases show "Blocked by".
3. The newest row is shown after a re-run.
4. The 503 `BOB_UNAVAILABLE` response shows the dedicated state, without paths.
5. Baseline and post runs are separated.
6. The verdict is the backend's, even when all displayed runs passed.
7. The rollback button is hidden when unavailable; confirmation is required when available; a rollback failure is shown explicitly.
8. The evidence count is correct before the drawer opens.
9. Seven duplicate events cause one re-fetch, and two reconnects rehydrate without duplicating phases, keeping the terminal state.
10. Bob's narrative and the deterministic verdict are in separate regions, with the discrepancy shown.

Also covered: NO VERDICT and empty states, and live output ignoring other missions.

**Mutation checks** (each applied temporarily, then restored):

| Mutation | Tests failed |
|---|---|
| F1: stepper uses the oldest row | 3 |
| F2: a refresh per event, no debounce | 1 |
| F3: React overrides the verdict | 2 |
| F4: rollback button always shown | 1 |
| F5: unsafe Bob diagnostics passed through | 1 |

### Exact verification commands and results (2026-09-26)

| Dir | Command | Exit | Result |
|---|---|---|---|
| backend | `npm run typecheck` / `npm run build` | 0 / 0 | clean |
| backend | `npm test` | 0 | **8 files, 102/102 passed** (was 101; +1 rollback-status test) |
| frontend | `npm run typecheck` | 0 | clean (tests included) |
| frontend | `npm run lint` | 0 | clean (first time a config exists) |
| frontend | `npm run build` | 0 | JS 201.1 kB (62.7 kB gzip), CSS 18.1 kB |
| frontend | `npm test` | 0 | **2 files, 26/26 passed** |
| demo-app | `npm test` / `typecheck` / `lint` / `build` | 0 / 0 / 0 / 0 | 29/29 passed; clean |
| demo-app | `git` | — | HEAD `fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f`, `git status --porcelain` empty, no `refs/forgeguard/*`, no lock file |

### Live browser verification

**Setup:**

- Backend: `npm run dev` with `DB_PATH=<session scratchpad>/live-ui.db` and `BOB_CLI_PATH=C:\nonexistent\bob.js`.
- Frontend: `npx vite --port 5173`.
- Browser: headless Microsoft Edge driven through the Chrome DevTools Protocol by a scratchpad script. It performed the clicks and typing, and captured 15 screenshots, which were visually reviewed.

**Populating the validation and verdict panels.** A clearly labelled fixture mission ("UI VERIFICATION FIXTURE — IBM Bob was not invoked") was created honestly:

- The **real** orchestrator ran against demo-app, with a client that doesn't call Bob.
- The **real** baseline validation ran: 4 npm commands, all exit 0.
- The Phase 1 task was then recorded as failed with the reason "IBM Bob was not invoked", and the backend computed the verdict.
- No Bob process was spawned, and demo-app stayed clean.

**Observed:**

| Check | Result |
|---|---|
| Frontend starts, backend reachable through the proxy, WebSocket "Live updates: connected", sidebar "IBM Bob: UNAVAILABLE" | ✓ |
| Create with 12,001 characters | modal shows `ISSUE_TEXT_TOO_LONG: issueText must be at most 12000 characters` |
| Create a demo scenario | header shows `PENDING · CREATED`, repository `demo-app` |
| Run pipeline | **BOB UNAVAILABLE** panel (provider `shell`, version "not detected", reason `BOB_CLI_PATH points to "…/bob.js", which does not exist.`); status Failed; all 6 phases still pending (none created); no path fragment visible |
| Page reload | Bob-unavailable state rebuilt ("Source: preflight evidence recorded for this mission.") |
| Fixture mission | failure panel (`BOB_TASK_FAILED` + `unavailable`, `repo_understander (failed)`, task ID, time); 5 phases skipped, each "Blocked by: Repo Understanding" |
| Fixture mission, verdict | **BLOCKED** (backend: "Implementation did not succeed…"); the table shows 4× baseline PASS / post MISSING |
| Fixture mission, Bob analysis | "No Bob release narrative…" |
| Fixture mission, rollback | "unavailable: No rollback anchor `NO_ROLLBACK_ANCHOR`" and no Roll back button |
| Fixture mission, validation | 4 baseline runs with real stdout |
| Fixture mission, other | `Evidence (3)` before opening the drawer; "No live Bob output available." |
| Evidence drawer | tabs `Prompts (1) · Responses (0) · Structured output (0) · Observations (1) · Errors (1)`; the error card shows agent, FG task ID, "Bob task: not reported", status and times |
| Reconnect | the backend process was stopped with the page open, and the UI showed "disconnected (retrying)" while keeping the failed state. After the restart it reconnected and rehydrated to identical state: 6 phase statuses, 2 missions, 4 runs, verdict `blocked`, no duplicates. |
| 390 px viewport | no horizontal overflow |
| Browser console | 0 errors in every run |

One defect found in the live run and fixed: raw ANSI colour codes in stored vitest stdout were shown as noise. They are now hidden at display time only, with a note.

All servers and headless browser processes were stopped afterwards.

### Remaining limitations

1. **No live view of a successful Bob run.** Bob credits are exhausted, so the completed-mission, approval, discrepancy, post-validation and available-rollback screens are verified by component tests with backend-shaped fixtures, not by a live run.
2. **Live output is WebSocket-only.** It isn't persisted by the backend, so after a page reload during a running task the earlier chunks are gone. The persisted Bob responses are in the evidence drawer.
3. **Rollback status cost.** It runs a few git commands (about 0.5–1 s on this machine) and is fetched on every mission refresh. Polling stops for terminal missions, so this is bounded.
4. **Execution timeline.** It lists every historical row, including earlier attempts. That's intentional, but it can be long after many re-runs.
5. **Duplicated limit.** The frontend counter hard-codes the 12,000-character limit, which duplicates `backend/src/config.ts`. The backend still enforces it.
6. **Backend blockers still open** (see Milestone 5 §11):
   - no restart recovery for in-flight missions
   - no authentication
   - prompt injection (audit S4)
   - `npm start` `schema.sql` copy

### Recommended next milestone

**Replay/Demo Mode.** Record a clearly labelled, deterministic replay of backend states and events, so judges can walk through approval, implementation, post-validation, a verdict with a discrepancy, and rollback without Bob credits. The UI already renders all of these states from the backend. Replay needs to be a labelled data source, never presented as a live Bob run.


---

## Milestone 7 Results

**Date:** 2026-09-27 · **Engineer:** Claude Code (Opus 5.5).

**IBM Bob was not invoked and no Bob credits were used.**

- No real mission was started, and `POST /api/missions/:id/start` was not called.
- The rehearsal backend ran with `BOB_CLI_PATH=C:\nonexistent\bob.js`.
- A direct process scan found no `bobshell` / `bob.js` process.
- The rehearsal backend log has no pipeline or spawn entries. The only grep match was the word "respawn" in the `ts-node-dev` command line.

**The demo-app Git state was not changed.** HEAD is `fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f` before and after, `git status --porcelain` is empty, there are no `refs/forgeguard/*`, and there is no lock file. The `dist/server.js` timestamp is unchanged, so no `npm run build` ran against demo-app during replay.

Design: [DEMO_REPLAY.md](DEMO_REPLAY.md).

### Files changed

**Backend, new:**

| File | Purpose |
|---|---|
| `src/replay/ReplayTypes.ts` | replay types |
| `src/replay/ReplayEngine.ts` | pure view builder: real verdict and reconciliation functions, real prompt templates |
| `src/replay/ReplayStore.ts` | in-memory sessions, clock, controls, reset, fixed fixture registry |
| `src/replay/snapshots.ts` | named views used as frontend test fixtures |
| `src/replay/fixtures/{safe-fix, regression-blocked, bob-disagreement}.json` | the three scenarios |
| `src/routes/replay.ts` | replay API |
| `scripts/generate-replay-snapshots.ts` | writes the frontend snapshot file |
| `tests/replay.test.ts` | 18 tests |

**Backend, changed:**

| File | Change |
|---|---|
| `src/app.ts` | mounts `/api/replay` |
| `src/ws/events.ts` | `replay.updated` event type |
| `package.json` | `replay:snapshots` script |

The mission pipeline, the Bob clients, validation, rollback and the database schema are unchanged.

**Frontend, new:**

| File | Purpose |
|---|---|
| `src/components/MissionView.tsx` | presentational mission view, extracted from `Dashboard` |
| `src/components/replay/ReplayWorkspace.tsx` | selector, banner, controls, workspace |
| `src/store/replayStore.ts` | replay state |
| `src/lib/display.tsx` | replay display context and T+ times |
| `src/test/replay-views.json` | generated from the engine |
| `src/components/replay/replay.test.tsx` | 12 tests |

**Frontend, changed:**

| File | Change |
|---|---|
| `Dashboard.tsx` | now a live wrapper around `MissionView` |
| `App.tsx` | live/replay switch, replay evidence drawer, replay rehydration |
| `Sidebar.tsx` | "Demo replay" entry |
| `store/store.ts` | `view`; `replay.*` events routed to the replay store |
| `types.ts`, `api.ts` | replay types and endpoints |
| `MissionHeader`, `FailurePanel`, `BobUnavailablePanel`, `ValidationPanel`, `RollbackPanel`, `ReleasePanel`, `EvidenceDrawer`, `ExecutionTimeline`, `AgentPanels` | display-context time formatting and replay labels |
| `ReleasePanel` (live too) | "Bob recommends: …" and "DISAGREEMENT DETECTED" |

**Docs:** new `docs/DEMO_REPLAY.md`, a replay section in `docs/UI_ARCHITECTURE.md`, and this section.

### Replay architecture

```
Frontend → /api/replay/* → ReplayStore → ReplayEngine → fixtures
```

- The view is a pure function of (fixture, position, approved, rolledBack). It is shaped like the live mission REST data, so the existing Milestone 6 panels render it through `MissionView`.
- The verdict comes from the real `computeReleaseVerdict`, and the discrepancy from the real `reconcileBobAssessment`.
- Sessions live in memory only. The only side effect is the `replay.updated` WebSocket event.
- Controls: play, pause, restart, skip to next, approve (the gate always stops playback), rollback (replay only), and speed 1x / 2x / 4x.

### Scenarios

| Scenario | Computed final state |
|---|---|
| Safe Fix | **READY**; the synthetic narrative agrees; the replay rollback sets `rolled_back` and changes no files |
| Regression Blocked | **BLOCKED**, because `npm test` regressed (baseline pass → post exit 1); Validation failed, Release Report skipped, rollback available |
| Bob Disagreement | **BLOCKED** (typecheck and build regress) while the synthetic narrative recommends READY → **DISAGREEMENT DETECTED**, deterministic verdict authoritative |

For Bob Disagreement, the UI and the docs both state the fidelity note: a real run skips Phase 6 after BLOCKED.

### Tests

**Backend `tests/replay.test.ts`** (18 tests):

1. scenario listing, with no internal paths
2. starting a replay
3. no Bob: the `createBobClient` factory, the only route to a Bob client, is spied
4. no `MissionOrchestrator` / `startMission` / `executeCommand`
5. no git (`git`, `gitOk`, `createAnchor`, `restoreAnchor`, `recordResultSnapshot`), no `child_process`, no `getDatabase`. Checked with runtime spies across full runs of all scenarios, and with a static import scan.
6. determinism: step-by-step equality of two sessions; the view is a pure function; replay timestamps only
7. Safe Fix reaches READY, and its replay rollback changes no files
8. Regression Blocked reaches BLOCKED with the regression classified
9. Bob Disagreement: the deterministic verdict stays authoritative
10. identifiers: `replay-*` only, no UUIDs, Bob task ID always null, every item marked replay
11. reset removes the session state
12. demo-app HEAD, status and refs unchanged, and no `execFileSync` during replay

Also covered:

- a positive control proving the spies record calls
- 404/400 handling for unknown scenarios, `..%2F`, `__proto__`, bad actions and bad speeds
- no paths, home directory, Bob data or secrets in responses
- the playback clock, gate, pause, speed, approve and restart (fake timers)
- the snapshot file matching the engine output
- every fixture valid, with its declared outcome equal to the computed verdict

**Frontend `replay.test.tsx`** (12 tests):

1. scenario selector
2. banner present in replay and absent on a live mission
3. phase progression and the approval gate
4. validation rendering
5. release verdict rendering
6. Bob disagreement rendering
7. replay rollback
8. pause, play, skip, restart and speed control calls (never the mission API)
9. no live-Bob wording, and T+ times on every replay view
10. refresh survival and a forgotten reset session

Also covered: `replay.updated` refreshing only the replay, and evidence drawer labelling.

**Mutation checks** (frontend, each applied temporarily then restored):

| Mutation | Tests failed |
|---|---|
| R1: banner removed | 1 |
| R2: replay display mode off | 4 |
| R3: replay rollback outcome hidden | 1 |
| R4: approve routed nowhere | 1 |

### Exact verification results (2026-09-27)

| Dir | Command | Exit | Result |
|---|---|---|---|
| backend | `npm run typecheck` / `npm run build` | 0 / 0 | clean |
| backend | `npm test` | 0 | **9 files, 120/120 passed** (was 102; +18 replay) |
| backend | `npm run test:integration` | 0 | **1/1 passed** (real demo-app validation, 89 s) |
| frontend | `npm run typecheck` / `npm run lint` / `npm run build` | 0 / 0 / 0 | clean; JS 214.9 kB (66.4 kB gzip), CSS 19.6 kB |
| frontend | `npm test` | 0 | **3 files, 38/38 passed** (was 26; +12 replay) |
| demo-app | `npm test` / `typecheck` / `lint` / `build` | 0 / 0 / 0 / 0 | 29/29 passed; clean |
| demo-app | `git` | — | HEAD `fc6794e…`, `git status` empty, no ForgeGuard refs, no lock file |

### Demo rehearsal

The rehearsal used headless Microsoft Edge driven through the Chrome DevTools Protocol, against the real backend (with the safe Bob configuration and a throwaway database) and Vite.

**Safe Fix:**

- selector → START REPLAY → 4x → stops at "Waiting for approval" with the plan shown → Approve plan → finished
- **READY**: 6 phases completed, 8 validation runs passed, no discrepancy, Bob recommends READY, rollback available
- Roll back → Confirm: "DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK … No file was restored or removed", status ROLLED BACK
- evidence drawer "Evidence (replay fixtures)"
- the page reload restored the replay, still ROLLED BACK

**Regression Blocked:** **BLOCKED**, "`npm test` exited 1 after implementation but passed in the baseline (regression)"; Validation failed, Release Report skipped; post `npm test` failed.

**Bob Disagreement:** **BLOCKED** (typecheck and build regressions); the synthetic narrative says READY; "DISAGREEMENT DETECTED … the deterministic verdict is used".

**Across all runs:**

- banner visible at every checkpoint
- 6 phase cards (no duplicates)
- no live-Bob wording
- **0 console errors**
- no failed replay or mission API calls; the only non-2xx responses were the expected `503 /api/health/bob` from the sidebar's Bob indicator

**Defect found and fixed during the rehearsal:**

- **Symptom:** after scrolling, the whole app shifted up and left an empty band.
- **Cause:** the screen-reader-only table caption is absolutely positioned. With no positioned ancestor, it extended the document height, so `<html>` scrolled.
- **Fix:** scroll containers are now `position: relative` and the shell uses `overflow: clip`.
- **Verified:** after the fix, only the panel scrolls (`<html>` scrollTop 0). This also affected the live mission view.

The servers and headless browser processes were stopped afterwards, and the temporary databases are in the session scratchpad only.

### Remaining limitations

1. **The fixtures are hand-written illustrations.** They are not recordings of Bob. The specialist findings and narratives are plausible but synthetic, and are labelled as such.
2. **Bob Disagreement shows a state the live pipeline can't reach.** A real run skips Phase 6 after BLOCKED, so there would be no Bob narrative there. This is disclosed in the UI and the docs.
3. **Sessions are lost on a backend restart.** They're in memory only; the UI then returns to the selector with a message.
4. **Only three fixed scenarios.** Adding one means writing a fixture JSON file and registering it in `ReplayStore.ts`.
5. Unchanged from earlier milestones: live Bob remains unverified, and there is no authentication and no restart recovery.

> Superseded: limitation 2 above was fixed in the final correction below.


---

## Final Replay Correction + QA

**Date:** 2026-09-27 · **Engineer:** Claude Code (Opus 5.5).

- IBM Bob was **not** invoked, no credits were used, and no real mission was started.
- demo-app was **not** modified.

### Correction: Bob Disagreement is now live-reachable

- **Before:** a BLOCKED verdict combined with a Bob Phase 6 narrative. That state is unreachable, because the live pipeline skips Phase 6 after BLOCKED.
- **Now:**

| Command | Baseline | Post |
|---|---|---|
| lint | pass | pass |
| test | **FAIL** | **FAIL** |
| typecheck | pass | pass |
| build | pass | pass |

  → **CONDITIONAL** (`npm test`: `preexisting_failure`). Phase 6 completes, the synthetic Bob narrative says **READY**, and the UI shows **DISAGREEMENT DETECTED**. The mission is `complete`.
- **Transparency note** (in the UI): "The validation finding is preserved… Bob's narrative is advisory and cannot change the decision."
- **Engine change:** the BLOCKED branch no longer attaches a narrative.
- **New `validateFixture` rules:**
  - a narrative requires a completed `release_report` phase
  - a blocked scenario cannot have a narrative
- The live verdict logic is **unchanged**.

**Files changed:**

- `backend/src/replay/fixtures/bob-disagreement.json`
- `backend/src/replay/ReplayEngine.ts`
- `backend/tests/replay.test.ts` (test 9 rewritten, +1 reachability test)
- `frontend/src/components/replay/replay.test.tsx` (test 6 rewritten)
- `frontend/src/test/replay-views.json` (regenerated)
- `docs/DEMO_REPLAY.md`, and this section

### Final QA: static checks

| Check | Result |
|---|---|
| Live path never imports replay code | Only `app.ts` (mounting) and `events.ts` (event type) reference replay outside `src/replay`. `MissionOrchestrator` and `routes/missions.ts` do not. |
| Replay imports no execution path | Replay imports only `pipeline/prompts`, `pipeline/releaseVerdict`, `ws/EventBus`, its own files, fixtures and `express`. No `child_process`, git, db, Bob client or orchestrator import (also asserted by a test). |
| Live start runs the Bob preflight | `startMission` still runs, in order: `resolveAllowedRepo` → `resolveRepoRoot` → `readRepoLock` → `bobClient.checkAvailability()` → 503 `BOB_UNAVAILABLE`. Covered by the existing pipeline test. |

### Final QA: commands (run sequentially)

| Dir | Command | Exit | Result |
|---|---|---|---|
| backend | `npm run typecheck` / `npm run build` | 0 / 0 | clean |
| backend | `npm test` | 0 | **9 files, 121/121 passed** |
| backend | `npm run test:integration` | 0 | **1/1 passed** (8 real demo-app runs, all exit 0) |
| frontend | `npm run typecheck` / `npm run lint` / `npm run build` | 0 / 0 / 0 | clean (JS 214.9 kB, CSS 19.6 kB) |
| frontend | `npm test` | 0 | **3 files, 38/38 passed** |
| demo-app | `npm test` / `typecheck` / `lint` / `build` | 0 / 0 / 0 / 0 | 29/29 passed; clean |
| demo-app | `git` | — | HEAD `fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f`; `git status --porcelain` empty; no `refs/forgeguard/*`; no lock file |

### Final QA: browser rehearsal

The rehearsal used headless Edge driven through the Chrome DevTools Protocol. The backend ran with `BOB_CLI_PATH` pointing at a missing file and a throwaway database, alongside Vite.

**Scenarios:**

| Scenario | Result |
|---|---|
| Safe Fix | **READY**; Bob READY; replay rollback "DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK", status ROLLED BACK; survives a reload |
| Regression Blocked | **BLOCKED**: "`npm test` exited 1 after implementation but passed in the baseline (regression)". Validation failed, Release Report skipped. |
| Bob Disagreement | **CONDITIONAL**: "`npm test` failed before and after implementation … pre-existing failure, not a regression". Bob **READY**, **DISAGREEMENT DETECTED**, all 6 phases completed. |

**Checks:**

| Check | Result |
|---|---|
| Phase cards per scenario | 6 (no duplicates) |
| Replay banner | visible at every checkpoint |
| Live-Bob wording | none |
| Document scrolling | `<html>` scrollTop always 0 (no layout shift) |
| Mission database | 1 mission before the replays and 1 after them. The final count is 2 because the rehearsal then created one live mission itself (never started) to test navigation. |
| Navigation | live mission (no banner, "Run pipeline" present) → Demo replay → start → back to the live mission (no banner) → Demo replay resumes the active replay → Exit replay → selector: all working |
| 390 px width | no horizontal overflow on the live mission, the selector or a replay session |
| Console errors | 0 |
| Non-2xx responses | only the expected `503 /api/health/bob` from the sidebar indicator |
| demo-app | unchanged: HEAD, status, refs and the `dist/server.js` timestamp are identical before and after |
| Bob processes | a direct process scan found **0** `bobshell` / `bob.js` / `bob` processes |

### Regressions since Milestone 7

None found. The only QA issue was in the rehearsal script itself: it assumed "Demo replay" always opens the selector, but the app correctly resumes a replay that hasn't been exited. The script was fixed; the app was not changed.

### Final statement

- Replay Mode is deterministic fixture data and never invokes IBM Bob.
- Live missions use the real Bob integration path, with the availability preflight.
- IBM Bob 2.0 was used during development. That evidence is preserved separately (`~/.bob/db/bob.db`, §9) and is not reused as replay data.
- Replay exists to make the product demonstration deterministic and safe.

### Remaining submission risks

1. **No ForgeGuard mission has completed with live Bob.** Credits are exhausted. The Bob integration is verified with the real CLI's `--version` and `run --help`, and through a fake entry point in tests, but not through a real task.
2. **Replay content is hand-written.** Judges must read the labels. The banner and the labels are prominent, and are tested.
3. **Pressing "Run pipeline" on a live mission with Bob configured would start real, paid Bob tasks.** For the demo, run the backend with Bob unavailable (for example `BOB_CLI_PATH` pointing at a missing file). With credits exhausted, a live start would otherwise fail on budget, truthfully.
4. **`npm start` from `dist` still fails** because `schema.sql` isn't copied. Use `npm run dev` for the demo.
5. **Operational gaps:** no authentication; no restart recovery for in-flight missions; replay sessions are lost on a server restart (the UI returns to the selector with a message).
