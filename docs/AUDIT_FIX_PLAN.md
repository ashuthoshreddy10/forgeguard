# ForgeGuard — Audit Fix Plan

Generated: 2025-09-25  
Audited by: Bob (architecture audit gate)

---

## P0 — Prevents the demo from working

### P0-1: `bob` CLI is not installed; BobShellClient will always fail

**Problem:** `BobShellClient` calls `spawn('bob', [...])` (or `process.env.BOB_CLI_PATH ?? 'bob'`). Bob Shell (`bob`) is **not on PATH** in this environment. The only IBM Bob binary is `bobide.cmd` (the IDE), which does not support the `-p` non-interactive mode. Every pipeline task will fail immediately with `Failed to spawn Bob Shell: <error>`.

**Affected files:**
- `backend/src/bob/BobShellClient.ts`
- `backend/.env.example` (documents `BOB_CLI_PATH=bob`)

**Why it matters:** Without a working Bob client, the entire pipeline produces only failure records. The demo cannot run.

**Recommended fix:**
1. Set `BOB_CLI_PATH` in `.env` to the absolute path of the installed Bob Shell binary once Bob Shell is installed: `%USERPROFILE%\AppData\Local\Programs\IBM Bob\bin\bobide.cmd`.
2. Determine if `bobide chat` (the only available subcommand) can be used headlessly. Based on the help output it opens a GUI window, not a headless process — Bob Shell (`bob`) must be installed separately via `powershell -ep Bypass 'irm -Uri "https://bob.ibm.com/download/bobshell.ps1" | iex'`.
3. Until Bob Shell is installed, the demo cannot execute real pipeline phases.

**Required before demo:** YES

---

### P0-2: Workspace (demo-app) is not a git repository; rollback will silently fail

**Problem:** `git stash push` in `MissionOrchestrator.createRollbackAnchor()` runs against `demo-app/` as the `cwd`. This directory is not a git repository (confirmed: `git status` returns exit code 128, "not a git repository"). The stash silently returns `null`, no `rollback_ref` is saved, and `POST /api/missions/:id/rollback` returns HTTP 400 "No rollback ref found".

**Affected files:**
- `backend/src/pipeline/MissionOrchestrator.ts` (lines 298–326)
- `backend/src/routes/missions.ts` (rollback route)

**Why it matters:** Phase 4 (Implementation) allows Bob to write files with no safe rollback path. If Bob's implementation is incorrect, there is no automated recovery.

**Recommended fix:** Initialize a git repository in `demo-app/` before the demo:
```bash
cd demo-app
git init
git add .
git commit -m "initial state for ForgeGuard demo"
```
Document this as a required pre-demo setup step.

**Required before demo:** YES

---

### P0-3: `npm run lint` in validation phase will fail; demo-app `lint` script uses incompatible flags

**Problem:** Phase 5 runs `npm run lint` in the demo-app directory. The demo-app `lint` script calls `eslint src tests --ext .ts`. ESLint v9 (flat config) does not support `--ext`. Confirmed exit code 2 with error: `Invalid option '--ext'`. The lint command will always fail, making every mission's validation phase report a lint failure.

**Affected files:**
- `demo-app/package.json` (lint script)
- `demo-app/eslint.config.js` (tsconfig.json excludes `tests/`)
- `backend/src/pipeline/MissionOrchestrator.ts` (runValidation)

**Why it matters:** Phase 5 always records a failing lint run. The release report will always say validation failed even when the code is correct.

**Recommended fix:** Fix the lint script in `demo-app/package.json`:
```json
"lint": "eslint src tests"
```
Also fix `demo-app/tsconfig.json` to include `tests/` or create a separate `tsconfig.test.json`.

**Required before demo:** YES

---

## P1 — Causes incorrect or misleading behavior

### P1-1: Double JSON serialization in `completePhase()`

**Problem:** `PhaseRunner.completePhase()` (line 68) calls `JSON.stringify(output)` on the `output` parameter — but callers already pass a JSON string (e.g., `JSON.stringify(repoSummary)`). The result stored in `pipeline_phases.output` is a double-encoded string like `"\"{ \\\"summary\\\": ... }\"" `, not valid JSON. The UI cannot parse it.

**Affected files:**
- `backend/src/pipeline/PhaseRunner.ts` (line 68)

**Why it matters:** Phase output displayed in the UI or used by downstream phases will be garbled.

**Recommended fix:** Remove the extra `JSON.stringify`:
```typescript
.run(now, output ?? null, phaseId);
```

**Required before demo:** YES

---

### P1-2: README and ARCHITECTURE.md misrepresent Phase 2 as "Bob subagents"

**Problem:** `README.md` says "5 subagents in parallel". `ARCHITECTURE.md` says "5 BobShellClient invocations in parallel (Promise.all)". `MissionOrchestrator.ts` line 7 says "5 Bob subagents in parallel". The actual mechanism is **5 independent Bob Shell process invocations** via `Promise.all`. This is not IBM Bob's subagent mechanism (which is a Bob-internal feature where Bob spawns its own child agents). Misrepresenting this to hackathon judges is inaccurate.

**Affected files:**
- `README.md`
- `docs/ARCHITECTURE.md`
- `backend/src/pipeline/MissionOrchestrator.ts` (comment on line 7)

**Why it matters:** Judges who know IBM Bob will notice the misrepresentation. It undermines credibility.

**Recommended fix:** Replace "subagents" with "independent Bob Shell sessions" in all three files.

**Required before demo:** YES

---

### P1-3: `failPhase()` is imported but never called; failed tasks do not mark their phase as failed

**Problem:** `failPhase` is imported from `PhaseRunner` in `MissionOrchestrator.ts` but is never invoked. When a Bob task fails (e.g., Bob Shell not found), the task record is marked `failed` but the containing `pipeline_phase` row remains `running` forever. The UI shows the phase as still running even after the mission fails.

**Affected files:**
- `backend/src/pipeline/MissionOrchestrator.ts`

**Why it matters:** UI shows incorrect phase state; evidence record is misleading.

**Recommended fix:** Wrap each phase's task execution in try/catch and call `failPhase()` on error before re-throwing.

**Required before demo:** YES

---

### P1-4: BobShellClient uses `--approval-mode auto_edit` but Bob Shell docs show `--yolo` for file writes

**Problem:** `BobShellClient.buildArgs()` passes `--approval-mode auto_edit` when `allowFileWrites=true`. IBM Bob documentation confirms both `--yolo` and `--approval-mode` are valid. However, `--max-turns` is also passed — this flag is not listed in the verified `bobide chat --help` output and may not be supported by all Bob Shell versions.

**Affected files:**
- `backend/src/bob/BobShellClient.ts` (lines 157–165)

**Why it matters:** Unknown flags may cause Bob Shell to refuse the command or behave unexpectedly.

**Recommended fix:** Verify `--max-turns` against the installed Bob Shell version before the demo. Remove it if unsupported.

**Required before demo:** Verify before demo.

---

### P1-5: `updateMissionStatus()` dynamic SQL column injection risk

**Problem:** `PhaseRunner.updateMissionStatus()` (lines 115–119) builds a SQL `SET` clause by directly interpolating object keys: `` `${k} = ?` ``. The values are parameterized but the column **names** are not. Any caller passing an untrusted `extra` object key could inject arbitrary SQL column names.

**Affected files:**
- `backend/src/pipeline/PhaseRunner.ts` (lines 115–119)

**Why it matters:** SQL injection risk if `extra` keys are ever derived from external input.

**Recommended fix:** The function is currently only called internally with hardcoded keys, so the immediate risk is low. However, the `extra` parameter is not used anywhere — remove it entirely to eliminate the risk class.

**Required before demo:** Remove unused `extra` parameter.

---

### P1-6: `BobApiClient` is a non-functional stub but is selectable via `BOB_PROVIDER=api`

**Problem:** `BobApiClient.runTask()` always returns `success: false` with the error "REST API provider is not yet implemented". If `BOB_PROVIDER=api` is set in `.env`, every pipeline task will fail silently-ish with this error stored in the DB.

**Affected files:**
- `backend/src/bob/BobApiClient.ts`

**Why it matters:** A developer could set `BOB_PROVIDER=api` thinking there is a fallback, and see all tasks fail with a confusing error.

**Recommended fix:** Add a startup check that throws if `BOB_PROVIDER=api` is configured, making the stub explicit at startup rather than at runtime.

**Required before demo:** YES.

---

## P2 — Important quality issues

### P2-1: No backend tests exist

**Problem:** `backend/` has vitest configured but zero test files. The backend pipeline, TaskManager, StreamParser, and database are entirely untested.

**Affected files:** `backend/` (all `src/` files)

**Recommended fix:** Add unit tests for `StreamParser` (pure functions, easy to test) and integration tests for `TaskManager` using a mock BobClient.

---

### P2-2: `demo-app` lint script has two separate bugs (incompatible flag + tests/ not in tsconfig)

**Problem:** (1) `--ext .ts` flag incompatible with ESLint v9 flat config. (2) `tsconfig.json` excludes `tests/` so `parserOptions.project` fails for test files.

**Recommended fix:** Fix both in P0-3 above.

---

### P2-3: `agent.started` / `agent.completed` / `agent.failed` WebSocket events are never emitted

**Problem:** `TaskManager.runTask()` never broadcasts `agent.started`, `agent.completed`, or `agent.failed` events. The `ParallelAnalysisGrid` component relies on task status to show spinning/done cards — but it reads that state from the REST poll, not WS events. The streaming output feature (`agent.output` events) is also never emitted because `BobShellClient` calls `options.onChunk` but `TaskManager.runTask()` does not pass an `onChunk` callback that broadcasts to the EventBus.

**Affected files:**
- `backend/src/bob/TaskManager.ts`

**Recommended fix:** Add EventBus broadcasts in `TaskManager.runTask()` for `agent.started`, `agent.output`, and `agent.completed`/`agent.failed`.

---

### P2-4: `mission.created` event is never broadcast

**Problem:** `POST /api/missions` inserts the mission row but never broadcasts `mission.created`. The Sidebar only refreshes when `refreshTick` is bumped, which only happens on WS events. A mission created in one browser tab will not appear in a second tab's sidebar until that tab polls.

**Affected files:**
- `backend/src/routes/missions.ts` (POST / handler)

---

### P2-5: Evidence count in Dashboard header is always 0

**Problem:** The Dashboard header shows `Evidence (N)` where N comes from `useStore(s => s.evidence)`. Evidence is only loaded when the EvidenceDrawer is opened. The count will always show 0 until the drawer is opened.

**Affected files:**
- `frontend/src/components/Dashboard.tsx`

---

## P3 — Polish / optional

### P3-1: `BOB_APPROVAL_MODE` env var is documented in `.env.example` but never read

The backend reads `allowFileWrites` from the task options and passes `--approval-mode auto_edit` directly. The env var is unused.

### P3-2: `backend/src/pipeline/PhaseRunner.ts` — `failPhase` exported but unused externally

Can be removed from exports until it is wired into the orchestrator.

### P3-3: `ARCHITECTURE.md` says "PipelineController (future)" but the orchestrator now exists

The doc should be updated to reflect that `MissionOrchestrator` now exists.

### P3-4: `docs/ARCHITECTURE.md` still labels pipeline as "Future Pipeline Phases (Milestone 2+)"

These phases are now partially implemented.
