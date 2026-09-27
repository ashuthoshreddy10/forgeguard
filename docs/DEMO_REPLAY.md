# Demo Replay Mode

**IBM Bob 2.0 was used to build ForgeGuard.** Replay Mode demonstrates the ForgeGuard workflow using deterministic fixture data, because live Bob execution is not available during the demonstration: the Bob credits are exhausted.

Replay data is never presented as output from a live Bob run.

## 1. Purpose

A judge can walk through the complete workflow and see how the product handles each case:

- repository understanding
- five specialist analyses
- change plan
- approval gate
- implementation
- baseline and post-implementation validation
- deterministic release decision
- rollback

Replay does all of this **without** invoking IBM Bob, running npm commands, touching the demo-app repository or its Git state, or writing to the mission database.

## 2. Transparency rules (enforced in code and tests)

- **Banner.** Every replay screen shows a persistent banner: **DEMO REPLAY — NOT A LIVE BOB RUN · IBM Bob not invoked · No repository changes · Deterministic fixture data**. Live missions never show it.
- **Times are replay time.** Every timestamp is shown as `T+Ns` (for example **REPLAY TIME T+5s / T+12s**). These are replay steps, not claims about how long Bob took.
- **Identifiers say "replay".** Every identifier starts with `replay-`: `replay-mission-safe-fix`, `replay-task-001`, `replay-evidence-001`, `replay-run-001`, `replay-anchor-001`, `replay-session-001`.
  - Bob task IDs are always `null`. The evidence drawer shows "none (replay fixture; IBM Bob not invoked)".
  - No IDs from `~/.bob/db/bob.db` are used.
- **Every data item is marked.**
  - Every evidence item is marked **Replay fixture**.
  - Every validation stdout starts with `[REPLAY FIXTURE — command not executed; output is fixture data]`.
  - Every structured output starts with `[REPLAY FIXTURE — not produced by IBM Bob]`.
- **Bob-style narratives** are labelled **REPLAY FIXTURE — SYNTHETIC BOB NARRATIVE**.
- **Rollback** is labelled **DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK**. It states that no file was restored or removed, and lists what a *real* rollback would restore, for comparison only.
- **Prompts.** Replay shows the prompts that ForgeGuard's real templates (`prompts.ts`) produce, marked "In replay it is NOT sent to IBM Bob".
- **No live wording.** A frontend test checks every replay screen for words like "live", "running Bob", "Bob is executing" and "Bob just completed". The two mandated disclaimers are the only exception.

## 3. Architecture

```
frontend  Sidebar "Demo replay" → ReplayWorkspace (selector, banner, controls)
             │   renders the SAME MissionView panels as live missions,
             │   inside a replay DisplayProvider (labels + T+ times)
             ▼
          /api/replay/*   (routes/replay.ts)  ── separate from /api/missions
             ▼
          ReplayStore     in-memory sessions, playback clock, controls, reset
             ▼
          ReplayEngine    PURE: view = f(fixture, position, approved, rolledBack)
             │   uses the real computeReleaseVerdict + reconcileBobAssessment
             │   and the real prompt templates; nothing else
             ▼
          fixtures/*.json (fixed registry; scenario ids never become file paths)
```

- **Isolation.**
  - The replay modules import only `releaseVerdict.ts` (pure), `prompts.ts` (pure), `EventBus` (notifications) and their own files.
  - They never reach `createBobClient` / `BobShellClient` / `BobApiClient`, `MissionOrchestrator`, `executeCommand`, the git modules, `child_process` or the database.
  - Tests check this two ways: statically, by scanning the import lists, and at runtime, with call-recording spies around every one of those entry points while all three scenarios run, including approval and rollback. A positive-control test proves the spies do record calls.
- **Real logic, fixture inputs.**
  - The release verdict is computed by the same `computeReleaseVerdict` the live backend uses, over fixture validation rows.
  - The Bob/verdict discrepancy comes from the same `reconcileBobAssessment`.
  - Fixtures declare an `expectedVerdict` only as a test sanity check; it is never displayed.
- **State.** Sessions are in-memory only. They are never inserted into `forgeguard.db`. A session disappears on **Exit replay** (`DELETE`) or when the server restarts. At most 10 sessions are kept; the oldest is evicted.
- **Refresh survival.** The session ID is kept in `sessionStorage`. A page reload restores the replay from `GET /api/replay/:id`, and a reset session is forgotten.
- **WebSocket.**
  - Replay emits a single event type, `replay.updated` (`{ replayId, position, status }`), which makes the frontend re-fetch the replay.
  - No `mission.*`, `phase.*` or `agent.*` events are emitted, so live state is never touched.
  - Polling every 1.5 s is the fallback while playing.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/replay/scenarios` | id, title, purpose, expected final state, step count, replay duration |
| POST | `/api/replay/:scenario/start` | new session (201), plays automatically |
| GET | `/api/replay/:id` | current view (mission-shaped data plus replay metadata) |
| POST | `/api/replay/:id/control` | `{ action: play \| pause \| restart \| next \| approve \| rollback \| speed, speed?: 1\|2\|4 }` |
| DELETE | `/api/replay/:id` | reset: the session is removed |

Errors are structured:

| Code | HTTP |
|---|---|
| `REPLAY_SCENARIO_NOT_FOUND`, `REPLAY_NOT_FOUND` | 404 |
| `INVALID_REPLAY_ACTION`, `INVALID_REPLAY_SPEED` | 400 |
| `APPROVAL_REQUIRED`, `NOT_AWAITING_APPROVAL`, `REPLAY_FINISHED`, `ROLLBACK_ALREADY_DONE`, `ROLLBACK_NOT_ALLOWED` | 409 |

The existing Origin guard and body limit apply to these routes. Responses contain no filesystem paths, home directory, Bob data or environment values; a test checks this.

## 4. State machine

A session holds `position`, `approved`, `rolledBack`, `status` and `speed`. The view is recomputed from the fixture and those values every time.

```
start ──► playing ──(clock)──► … ──► awaiting_approval ──approve──► playing ──► … ──► finished
             ▲  │                         (gate: next is refused)                      │
             │  └─pause──► paused ──play──┘                                    rollback (if anchor)
             └──────────── restart (position 0, approval and rollback cleared) ◄───── finished
```

- **Clock.** The time until the next step is `max(Δt × 1000, 600 ms) / speed`. It is derived from the fixture's `t` values, never random.
- **next** applies one step immediately. It is refused at the approval gate and at the end.
- **Approval gate.** Playback always stops at the gate. Only **Approve plan** (in the controls) or **Approve & implement** (in the Change plan panel) continues it, as in the real pipeline.
- **rollback** is allowed only when the replay has finished, the mission is terminal and the fixture defines an anchor. Afterwards the mission status is `rolled_back`, a second rollback returns `ROLLBACK_ALREADY_DONE`, and no file changes.

## 5. Scenarios

| Scenario | Purpose | Final state (computed) |
|---|---|---|
| **Safe Fix** | Complete end-to-end successful engineering workflow | Baseline 4/4 pass, post 4/4 pass → **READY**. The synthetic narrative agrees. Rollback available; a replay rollback leaves the mission `rolled_back`. |
| **Regression Blocked** | Post-change validation exposes a regression | `npm test` passes in the baseline and fails after implementation (exit 1) → **BLOCKED** with classification `regression`. The Validation phase fails and the Release Report is skipped. Rollback available. |
| **Bob Disagreement** | Model recommendation conflicts with deterministic evidence | `npm test` fails in the baseline **and** after implementation (lint, typecheck and build pass both times) → **CONDITIONAL** (`preexisting_failure`). Phase 6 completes, and the synthetic Bob narrative recommends **READY** → **DISAGREEMENT DETECTED**. Mission `complete`. |

**Why this case.** Bob Disagreement is a **live-reachable** disagreement: a real ForgeGuard run can produce exactly this state, because Phase 6 runs after a CONDITIONAL verdict.

- **The deterministic decision** keeps the validation finding visible. The failure is pre-existing, so it is not a regression, but it is not ignored either.
- **Bob's narrative** is advisory only and cannot change the decision.
- **Everything else** in the scenario is labelled replay fixture data.

An earlier version showed a BLOCKED verdict with a Bob narrative. The live pipeline can never produce that, because Phase 6 does not run after BLOCKED. That version was removed, and the engine now enforces the rule:

- A blocked replay never gets a narrative.
- `validateFixture` rejects a fixture with a Bob narrative but no completed Phase 6.
- `validateFixture` rejects a blocked fixture that has a narrative.

## 6. Fixture format (`backend/src/replay/fixtures/*.json`, typed in `ReplayTypes.ts`)

| Field | Content |
|---|---|
| `id`, `title`, `purpose`, `expectedFinalState` | Selector card |
| `expectedVerdict` | Test sanity check against the computed verdict (never shown) |
| `transparencyNote` | Optional scenario-specific disclosure shown in the UI |
| `mission` | `issueText`, `repoLabel` (shown as `replay://demo-app`, "fixture; not modified") |
| `repoSummary`, `specialists.{code_impact_analyst, test_engineer, security_analyst, api_compat_analyst, doc_analyst}`, `changePlan`, `implementation` | Structured outputs, in the same shapes the real prompts request |
| `validation.baseline` / `validation.post` | Per required command: `exitCode`, `durationMs`, `stdout`, `stderr` |
| `bobNarrative` | Synthetic narrative (`releaseReadiness`, `summary`, `recommendation`, `remainingRisks`) or `null` |
| `rollback` | `anchorAvailable`, `wouldRestore`, `wouldRemove` |
| `timeline` | Ordered steps `{ t, label, action }`. Actions: `mission_created`, `phase_started`, `baseline_validation`, `phase_completed`, `approval_required`, `approved`, `post_validation`, `release_decision`, `mission_completed` |

`validateFixture()` runs when fixtures load. It checks that:

- the timeline starts with `mission_created`,
- time never goes backwards,
- `approval_required` is followed by `approved`,
- every required command has a baseline and a post result,
- the id is safe.

Frontend replay tests render snapshots generated from the real engine (`npm run replay:snapshots` in `backend/`), and a backend test fails if those snapshots are stale.

## 7. What replay does NOT demonstrate

- That IBM Bob can perform these analyses or this implementation. All Bob-style content is fixture text.
- Real command execution, timing, or validation timeouts.
- Real Git anchoring or rollback. The real rollback engine is verified separately with real Git in temporary repositories (`backend/tests/rollback.test.ts`).
- Streaming Bob output. The panel says replay has none.
- The Bob-unavailable preflight, repository allow-list, lock contention or other live safety paths. These are shown on real missions and covered by backend tests.

## 8. What is backed by real Bob development evidence

From `~/.bob/db/bob.db`, read-only, as recorded in `CLAUDE_AUDIT.md` §9:

- IBM Bob Shell 2.0.5 was used to plan and build ForgeGuard. That covers a planning task (which produced `IMPLEMENTATION_PLAN.md` and `BOB_WORKFLOW.md`), one native Bob subagent (workspace exploration), and a long implementation task.
- A later report task stopped with `BudgetExceededError — 40 Bobcoins`.

**No ForgeGuard mission has ever completed with live Bob.** Replay does not claim otherwise.

## 9. How judges should use replay mode

1. Open **Demo replay** in the sidebar, pick a scenario card and press **START REPLAY**.
2. Watch the phases advance in **REPLAY TIME**. Use **Pause / Play**, **Skip to next**, **Restart** and **1x / 2x / 4x** as needed.
3. At **Waiting for approval**, review the Change plan panel and press **Approve plan**.
4. At the end, compare the **DETERMINISTIC RELEASE DECISION** with the **AI / BOB ANALYSIS**. Open **Evidence** to see the prompts, fixture outputs and the verdict evidence.
5. In **Safe Fix**, press **Roll back → Confirm rollback** to see the rollback workflow. It is labelled as a replay rollback.
6. Press **Exit replay** to reset. Selecting a live mission in the sidebar returns to live mode. Opening **Demo replay** again resumes a replay that hasn't been exited.

## 10. Final statement

- **Replay Mode is deterministic fixture data.** Every screen, identifier, output and narrative in replay comes from fixtures, and is labelled as such.
- **Replay Mode never invokes IBM Bob.** It runs no npm command, child process or Git operation, and never writes to the mission database. This is enforced by the module boundaries and by runtime-spy tests.
- **Live missions use the real Bob integration path.** `POST /api/missions/:id/start` runs these checks before anything else, then the real pipeline:
  - repository allow-list
  - Git check
  - repository lock
  - **Bob availability preflight**
  The live path never imports replay code or fixtures.
- **IBM Bob 2.0 was used during development** to plan and build ForgeGuard.
- **The Bob development evidence is preserved separately**: in `~/.bob/db/bob.db` (read-only) and in `CLAUDE_AUDIT.md` §9. It is not reused as replay data.
- **Why replay exists:** it makes the product demonstration deterministic and safe while live Bob execution isn't available. It demonstrates the workflow; it does not demonstrate Bob.
