# UI Architecture — Operational Dashboard

The frontend makes backend state visible. It never decides anything itself.

- Every status, verdict, rollback decision and error comes from the backend.
- React selects, formats and lays that data out.

Stack: React 18, Vite 5, Tailwind 3, Zustand 4. Tests use Vitest, jsdom and Testing Library.

## 1. State model (`src/store/store.ts`)

| Slice | Source | Notes |
|---|---|---|
| `missions` | `GET /api/missions` | sidebar list |
| `detail.mission` | `GET /api/missions/:id` | status, error message, change plan, release report |
| `detail.phases` | `GET /:id/phases` | every row, including earlier attempts, with `seq` (insertion order) |
| `detail.tasks` | `GET /:id/tasks` | agent tasks with status, duration and error |
| `detail.evidence` | `GET /:id/evidence` | loaded **with the mission**, so counts are right before the drawer opens |
| `detail.validationRuns` | `GET /:id/validation-runs` | real command runs (baseline and post) |
| `detail.verdict` | `GET /:id/release-verdict` | deterministic verdict, recomputed by the backend |
| `detail.rollback` | `GET /:id/rollback-status` | read-only evaluation of the rollback gates |
| `startOutcomes[id]` | response to `POST /:id/start` | explains a refused start (for example 503 `BOB_UNAVAILABLE`) |
| `rollbackOutcomes[id]` | response to `POST /:id/rollback` | success lists, or code and message |
| `liveOutput` | WebSocket `agent.output` only | the one piece of UI state that isn't persisted by the backend |
| `bobHealth` | `GET /api/health/bob` | sidebar indicator; runs `bob --version` only, no prompt |
| `wsConnected`, `wsReconnects` | WebSocket lifecycle | |

Every REST slice is a `Loadable<T>` with `{ data, loading, error, loaded }`. Panels render four explicit states:

- **loading:** first load
- **empty:** the backend says there's nothing yet
- **success**
- **failure:** a fetch error with a Retry button; the previous data is kept

Responses for a mission that is no longer selected are discarded.

## 2. REST vs WebSocket responsibilities

- **REST is the source of truth.** Everything shown comes from a REST response.
- **WebSocket is a change signal.**
  - `handleWsEvent` doesn't patch UI state. For events about the active mission, and for any `mission.*` event, it schedules one **debounced (250 ms)** REST refresh of the whole mission and of the mission list.
  - So duplicated, reordered or dropped events can't produce duplicate or stale UI state. Seven events arriving at once cause a single re-fetch, and a test checks this.
- **Every (re)connect rehydrates.** `setWsConnected(true)` re-fetches the mission list and the active mission, because events missed while disconnected are never replayed.
  - Terminal states persist because they are read back from the database.
  - Tested in unit tests, and live: the backend was stopped and restarted under an open browser, and state was identical afterwards.
- **Fallback polling** every 5 s runs only while the mission is in progress or the socket is disconnected.
- **One unfiltered socket** is used, so switching missions doesn't reconnect it. Events for other missions only refresh the list, and their `agent.output` is ignored.

## 3. Mission state rendering

- **Header:** mission ID (full), status, repository, current phase, created and updated times, the full issue text (collapsible), and the backend `error_message` when the mission failed.
  - The status badge maps the backend status to a display category without inventing any:
    - `created` → **pending**
    - `analyzing` / `planning` / `implementing` / `validating` → **running** (the raw status is shown too)
    - `awaiting_approval` → **awaiting approval**
    - `complete` → **complete**
    - `failed` → **failed**
    - `rolled_back` → **rolled back**
  - The repository shows its folder name; the full path is in the tooltip.
- **Pipeline stepper:** `latestPhases()` picks the **newest row per phase**, by highest backend `seq` (falling back to response order). A re-run therefore never shows the stale first attempt. Each phase shows pending, running, completed, failed or skipped.
  - A skipped phase shows **"Blocked by: <phase>"**, parsed from the backend's `Blocked: phase "x" failed`.
  - A failed phase shows its error.
- **Failure panel** (`failureDetails()`): the failed phase, the agent/task and task ID (from `agent_tasks`), the time, the reason, and the classification.
  - The classification is the backend's own code: `REPO_LOCKED`, `NO_COMMITS`, `RELEASE_BLOCKED`, `BOB_TASK_FAILED` plus the Bob error kind in brackets such as `bob_error` or `timeout`, and so on.
  - Absolute filesystem paths in messages are shortened to `…/<name>` (`redactPaths`). Evidence content is already secret-redacted by the backend.
- **Bob unavailable:** a dedicated **BOB UNAVAILABLE** panel replaces the generic failure panel. It shows provider, version, diagnostic code, reason and check time.
  - After a reload it's rebuilt from the mission's `BOB_UNAVAILABLE` error and its persisted `preflight` evidence.
  - Only safe fields are shown. `command`, `entryPoint` and `resolvedVia`, which are filesystem internals, are dropped.
  - The stepper stays all-pending, because the backend created no phases.
- **Other start refusals** (for example 409 `REPO_LOCKED` or `ROLLBACK_PENDING`) show a "pipeline was not started" notice with the HTTP status and code.

## 4. Evidence rendering

- **Drawer:** has tabs for **Prompts, Responses, Structured output, Observations and Errors**, plus Other only when present, each with a count.
  - It's a modal dialog; Escape closes it.
- **Agent evidence** (rows with a `task_id`) also shows: agent name, ForgeGuard task ID, Bob task ID, task status, and start/completion times. The Bob task ID comes from the task's diagnostic evidence (`bobTaskId`), and reads "not reported" when Bob gave none.
- **Content:** shown in full as the backend stored it. It's collapsed to a few lines by default, never truncated permanently.
- **Terminal colour codes** (ANSI) are hidden at display time only, and the UI says so ("terminal colour codes hidden"). The stored evidence is unchanged.

## 5. Deterministic verdict presentation

- **"DETERMINISTIC RELEASE DECISION"** renders `GET /release-verdict` as-is:
  - **READY / CONDITIONAL / BLOCKED / NO VERDICT**
  - the backend's reasons
  - the per-command table: baseline, post and classification
- React doesn't recompute or adjust the verdict. A test gives the UI passing runs with a backend verdict of `blocked`, and the UI must show BLOCKED.
- **"AI / BOB ANALYSIS"** is a separate panel built from `missions.release_report`. It shows Bob's own assessment, summary, recommendation and remaining risks. When Bob disagrees, the backend's `discrepancy` text is shown there as a highlighted note.
- The two are never merged into one "AI verdict".
- **Validation panel:** the current run's rows only (`currentRunValidation`), in **BASELINE** and **POST-IMPLEMENTATION** sections. Each run shows command, kind, status (passed, failed, timed out, running), exit code (or "none (killed on timeout)"), duration, start and end, and full stdout and stderr (expandable). Rows from earlier attempts are counted, not mixed in.

## 6. Rollback interaction

- The panel shows `GET /rollback-status`. The backend evaluates the same gates as the rollback itself, read-only: no lock, no evidence, no changes to the working tree.
- **Available:** a **Roll back** button, then an explicit **Confirm rollback** step, then `POST /rollback`.
- **Unavailable:** no button. The UI shows the backend code, a title for it, the backend's reason, and details such as the changed paths or the lock holder.
  - `NO_ROLLBACK_ANCHOR`: no rollback anchor
  - `ROLLBACK_CONFLICT`: repository changed since the mission
  - `REPO_LOCKED`: repository locked by another operation
  - `ROLLBACK_NOT_ALLOWED`: mission not in a terminal state
  - `ROLLBACK_ALREADY_DONE`: already rolled back
  - `ROLLBACK_HEAD_MOVED`: commits were made after the anchor
  - and so on
- **After a rollback:** the outcome is shown (removed and restored files, or the failure code and message), and the mission, phases, tasks, evidence, validation, verdict and rollback status are all re-fetched.

## 7. Approval

- The change-plan panel shows summary, risk level, affected files, risks and security notes, testing required, rollback plan, steps, and approval state.
- **Approve & implement** is enabled only when:
  - the backend status is `awaiting_approval`,
  - the newest `change_plan` phase is `completed` (the backend fails that phase for an invalid plan), and
  - the plan parses.
- The backend's approve response is authoritative. A refusal (for example 409) is shown as "Approval refused: <code>: <message>".

## 8. Error handling

- `api.ts` turns every response into `{ ok, status, data }` or `{ ok: false, status, error: { code, error } }`. A network failure becomes `NETWORK_ERROR`, so components never see raw exceptions.
- Create-mission errors, such as `ISSUE_TEXT_TOO_LONG` or `REPO_NOT_ALLOWED`, are shown inside the modal.
- The character counter mirrors the backend limit (12,000), but the backend is the one that rejects.
- **Live Bob output:** shown only from real `agent.output` events. Otherwise the panel reads "No live Bob output available." There are no timers, placeholders or fake terminal effects.

## 9. Tests (`frontend/src/**/*.test.ts(x)`, `npm test`)

**`selectors.test.ts`** (12 tests): the pure selectors. Newest phase row, blocked-by, error classification and path redaction, ANSI stripping, failure details, safe Bob diagnostics, current-run validation, release-report parsing.

**`dashboard.test.tsx`** (14 tests): the rendered dashboard, the rollback panel and the store, with a mocked backend.

1. A failed mission shows the error.
2. Skipped phases show as skipped, with "Blocked by".
3. The latest row is shown after a re-run.
4. Bob unavailable shows its own state, without leaking paths.
5. Baseline and post runs are separated.
6. The verdict is the backend's.
7. The rollback button is hidden when unavailable, and requires confirmation when available.
8. The evidence count is correct before the drawer opens.
9. Duplicate events and reconnects don't duplicate phases.
10. The Bob narrative and the deterministic verdict stay separate.

Also covered: NO VERDICT and empty states, an explicit rollback failure, and live output ignoring other missions.

The fixtures (`src/test/fixtures.ts`) describe backend state for rendering. None of them represents a Bob run that happened.

## 10. Demo replay (Milestone 7)

See [DEMO_REPLAY.md](DEMO_REPLAY.md) for the full description. On the frontend side:

- **Shared panels.** `Dashboard` is now a thin live wrapper around the presentational `MissionView`. `ReplayWorkspace` feeds replay sessions into the same `MissionView`, so replay shows exactly the panels a live mission shows; nothing is duplicated.
- **Display context.** `lib/display.tsx` provides a `DisplayProvider`. In replay it switches every timestamp to `T+Ns` and turns on replay labels:
  - header badge
  - evidence badges and "Bob task: none"
  - "SYNTHETIC BOB NARRATIVE"
  - "DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK"
  - validation and verdict subtitles
  - the agent-output panel's statement that replay has no streamed Bob output
- **Replay store.** `store/replayStore.ts` holds replay state separately from live mission state. It mirrors the backend session through `/api/replay/*`.
- **Events.** The main store sends `replay.updated` WebSocket events to the replay store only.
- **Layout.** The scroll containers are `position: relative` and the app shell uses `overflow: clip`. That keeps absolutely positioned descendants, such as the screen-reader-only table caption, from extending the document. This fixed a shifted layout that was seen in both replay and live views.
