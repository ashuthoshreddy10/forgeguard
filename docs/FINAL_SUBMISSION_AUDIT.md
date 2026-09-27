# Final Submission Audit

**Date:** 2026-09-27 · **Auditor:** Claude Code (Opus 5.5) · **Scope:** the whole project at `%USERPROFILE%\.bob\playground`

This was a read-only audit.

- IBM Bob was **not** invoked and no Bob credits were used.
- `demo-app` was **not** modified.
- **The only change made: `README.md` was rewritten** to fix blocker B1 below. No code, test or other document was changed.

## Overall status

**READY TO SUBMIT, with one packaging decision to make first (B2).**

All builds and tests pass, the documented demo works from a clean install, and the replay scenarios end in the expected states. B1 (the README) was fixed during this audit.

## Submission blockers

| ID | Blocker | Status |
|---|---|---|
| **B1** | See details below. | **Fixed:** README rewritten |
| **B2** | See details below. | **Resolved by packaging:** one root repository; demo-app is a normal directory; baseline history imported (see "GitHub packaging" in `CLAUDE_AUDIT.md`) |

**B1 — the README was inaccurate and incomplete.** It was the entry point for judges, and it:

- claimed "every analysis, code change, and validation result is backed by actual Bob execution"
- never mentioned Replay Mode
- attributed validation to Bob (ForgeGuard runs validation)
- documented the removed `git stash` rollback and the wrong CLI (`bob -p --yolo`)
- listed a `tests/` folder that doesn't exist
- gave no Bob-free demo steps

The rewritten README covers the problem, solution, architecture, setup, demo, Replay Mode, the IBM Bob contribution (with its limits), tests and documentation.

**B2 — the repository packaging is undecided.** The project root is not a Git repository, and `demo-app/` is its own Git repository (baseline `fc6794e`). If the root is initialised and pushed as-is, Git adds `demo-app` as an *embedded repository*: a gitlink with **no files**, so the target app would be missing from the submission. Choose one:

- **(a) Archive (zip) submission.** Include the whole folder, including `demo-app/.git`. Nothing else is needed.
- **(b) Git submission.** Push `demo-app` as its own repository and add it as a submodule. This preserves `fc6794e`.
- **(c) Git submission, one repository.** Remove `demo-app/.git` before `git add`. The docs that cite the baseline SHA would then no longer match.

**Recommended:** (a) or (b).

**Resolution (packaging step).** A variant of (c) was chosen that keeps the baseline SHA:

- ForgeGuard is one root Git repository, with `demo-app/` as a normal tracked directory (no submodule, no nested `.git` tracked).
- The original commit `fc6794e` was imported as a merge parent, and the tag `demo-app-baseline` points at it.
- `node scripts/setup-demo-repo.mjs` re-creates `demo-app/.git` at exactly `fc6794e` after cloning. It is needed for the backend tests and live missions.

So the docs that cite `fc6794e` remain correct.

## Checklist results

| # | Check | Result |
|---|---|---|
| 1 | README covers problem, solution, architecture, setup, demo, Replay Mode and the Bob contribution | **Now yes** (B1 fixed) |
| 2 | No document claims Replay Mode is live Bob execution | **Pass.** `DEMO_REPLAY.md`, `UI_ARCHITECTURE.md` and `CLAUDE_AUDIT.md` all state that replay uses fixtures and doesn't invoke Bob. The Bob-authored `IMPLEMENTATION_PLAN.md` mentions a planned replay "from stored evidence" (a plan, not a claim). The README labels the Bob-authored docs as historical. |
| 3 | Bob contribution claims are supported by the evidence | **Pass** (details below) |
| 4 | Internal documentation links | **Pass.** 22 relative Markdown links (README, docs, demo-app README) resolve, with no broken anchors, and every backticked file reference exists. The rewritten README's links were re-checked. |
| 5 | Secrets | **Pass** (details below) |
| 6 | Run commands | Section "Exact run commands" below |
| 7 | Documented demo from a clean environment | **Pass** (details below) |
| 8 | Production builds | **Builds pass.** Backend `tsc` exit 0; frontend `vite build` exit 0 (JS 214.87 kB / 66.36 kB gzip, CSS 19.58 kB); demo-app `tsc` exit 0. **Known non-blocker (N1):** `npm start` (`node dist/server.js`) fails with `ENOENT … dist/db/schema.sql`. The README says to use `npm run dev`. |
| 9 | Tests | **Pass**; see "Exact test counts" |
| 10 | demo-app Git baseline | **Pass.** HEAD `fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f`, 1 commit, `git status --porcelain` empty, no `refs/forgeguard/*`, no lock file |
| 11 | Dead or broken routes and UI paths | **Pass** (details below) |
| 12 | Replay scenarios | **Pass.** Safe Fix → **READY**; Regression Blocked → **BLOCKED**; Bob Disagreement → **CONDITIONAL** with Bob **READY** and **DISAGREEMENT DETECTED**. The replay rollback is labelled "NOT A LIVE REPOSITORY ROLLBACK". Checked via the API and in the browser. |
| 13 | Replay isolation (Bob, npm, child processes, Git, mission database) | **Pass** (details below) |
| 14 | Genuine blockers | B1 (fixed) and B2 (packaging decision) |

**Check 3 — Bob contribution evidence.** `~/.bob/db/bob.db` was read with SQLite `readonly`, looking at metadata only:

| Task | Type | Messages | Ended with |
|---|---|---|---|
| #1 | planning | 205 | turn limit |
| subagent | parent = #1 | — | — |
| #3 | implementation | 235 | turn limit |
| #4 | final session | 100 | `BudgetExceededError` |

This matches `CLAUDE_AUDIT.md` §9 and the README. The Bob-authored docs and `.bob/` rules and skills are present.

The store now also holds **5 later task records (#5–#9) with 0 messages and no first message**, dated 2026-09-26 14:00–14:40 UTC and 2026-09-27 06:29 UTC. No prompt was sent in any of them. ForgeGuard's tests use a fake Bob entry point, and every server run in this work used a missing `BOB_CLI_PATH`. Their origin is **not attributed**: possibly an IDE session or CLI metadata. They carry no Bob work and are not claimed as evidence.

**Check 5 — secrets:**

- `.env` has the same keys as `.env.example`, and no API key has a value (`BOBSHELL_API_KEY` and `BOB_API_KEY` are empty).
- A scan for key-like strings (`sk-…`, private keys, GitHub and Slack tokens) outside `node_modules`, `dist` and databases found only two obviously fake test placeholders (`sk-pipeline-SECRET-abcdef`, `sk-replay-should-never-appear`).
- The `.gitignore` files exclude `.env`, `*.db*`, `*.log`, `node_modules` and `dist`.
- `backend/data/forgeguard.db` is the local dev database; it is git-ignored.

**Check 7 — clean environment.** The project was copied without `node_modules`, `dist`, databases or `.env`, then:

1. `npm ci`: backend 258 packages, frontend 423, demo-app 328. All exit 0.
2. Builds: all exit 0.
3. `npm run dev` for backend (with `BOB_CLI_PATH` missing) and frontend.
4. Through the proxy:
   - `/api/health` 200; `/api/health/bob` 503 (Bob unavailable, as intended)
   - create mission 201 (repository `demo-app`)
   - **start → 503 `BOB_UNAVAILABLE`**
   - all mission sub-routes 200
   - replay scenarios listed; all three played to the end with the expected verdicts
   - replay rollback labelled
   - mission count unchanged by replays
   - unknown route 404
5. In the browser: the full rehearsal passed, and the live path (oversized issue rejected, mission created, **Run pipeline → BOB UNAVAILABLE**, no phases, no path leak, survives a reload) passed with 0 console errors.

**Check 11 — routes and UI paths.** In the headless-Edge rehearsal on the clean install:

- live mission ↔ Demo replay ↔ back to live works
- "Demo replay" resumes an unfinished replay; Exit returns to the selector
- evidence drawer and page reload work
- 6 phase cards per scenario (no duplicates)
- no horizontal overflow at 390 px on the live, selector and replay views
- **0 console errors**
- the only non-2xx response was the intended `503 /api/health/bob`

**Check 13 — replay isolation.** Covered by tests and a static scan:

- The live path (`MissionOrchestrator`, `routes/missions.ts`) imports nothing from replay.
- Replay imports only `pipeline/prompts`, `pipeline/releaseVerdict`, `ws/EventBus`, its own files and its fixtures.
- Runtime spies in `tests/replay.test.ts` record **0** calls to Bob, the orchestrator, `executeCommand`, git, `child_process` or `getDatabase` across complete runs of all scenarios. A positive control proves the spies work.
- The mission count in the browser rehearsal is unchanged by replays.
- demo-app's HEAD, status, refs and `dist` timestamp are unchanged.
- A process scan found no Bob process.

## Exact test counts (real project, run sequentially, 2026-09-27)

| Package | Command | Result |
|---|---|---|
| backend | `npm test` | **9 files, 121/121 passed**, split as follows: pipeline 25, rollback 19, replay 19, BobShellClient 16, releaseVerdict 15, security 15, resolveBob 7, validationTimeout 4, database 1 |
| backend | `npm run test:integration` | **1/1 passed**: 8 real validation commands in demo-app, all exit 0 |
| frontend | `npm test` | **3 files, 38/38 passed**: selectors 12, dashboard 14, replay 12 |
| demo-app | `npm test` | **29/29 passed** |

Also run:

- backend `typecheck` and `build`: 0 / 0
- frontend `typecheck`, `lint` and `build`: 0 / 0 / 0
- demo-app `typecheck`, `lint` and `build`: 0 / 0 / 0

## Exact build results

| Package | Command | Exit | Output |
|---|---|---|---|
| backend | `npm run build` | 0 | `dist/` (includes the replay fixtures; **not** `schema.sql`, see N1) |
| frontend | `npm run build` | 0 | `dist/assets/index-*.js` 214.87 kB (66.36 kB gzip), `index-*.css` 19.58 kB |
| demo-app | `npm run build` | 0 | `dist/` (git-ignored, working tree stays clean) |

## Exact run commands

```bash
# once
node scripts/setup-demo-repo.mjs     # demo-app's own repo at fc6794e (needed for tests and live missions)
cd backend  && npm ci
cd ../frontend && npm ci
cd ../demo-app && npm ci

# demo (two terminals); Bob made unavailable on purpose
cd backend && BOB_CLI_PATH=/nonexistent/bob.js npm run dev          # bash
#            $env:BOB_CLI_PATH='C:\nonexistent\bob.js'; npm run dev   # PowerShell
cd frontend && npm run dev                                           # → http://localhost:5173

# verification
cd backend  && npm run typecheck && npm run build && npm test && npm run test:integration
cd frontend && npm run typecheck && npm run lint && npm run build && npm test
cd demo-app && npm test && npm run typecheck && npm run lint && npm run build
```

Both forms of `BOB_CLI_PATH` were checked with `resolveBobLaunch`, and both resolve to "unavailable".

## Recommended recording and demo procedure (about 5 minutes)

1. **Start the servers** exactly as above, with Bob unavailable. Open `http://localhost:5173`. The sidebar shows "Live updates: connected" and "IBM Bob: UNAVAILABLE".
2. **Opening statement, verbatim:** "IBM Bob 2.0 was used to build ForgeGuard. Replay Mode demonstrates the workflow with deterministic fixture data because live Bob execution is not available." Keep the replay banner in frame.
3. **Live safety (30 s):** + New mission → a demo scenario → Create → **Run pipeline** → the **BOB UNAVAILABLE** screen. Explain that the preflight runs before any phase.
4. **Safe Fix:** Demo replay → Safe Fix → START REPLAY → 2x. At **Waiting for approval**, show the change plan, then **Approve plan**. At the end, show:
   - **READY**
   - the baseline vs post table
   - AI / BOB ANALYSIS (labelled synthetic)
   - Evidence drawer
   - **Roll back → Confirm**, and read the "NOT A LIVE REPOSITORY ROLLBACK" label aloud
5. **Regression Blocked:** show **BLOCKED**, the `npm test` regression row, the failed Validation phase and the skipped Release Report.
6. **Bob Disagreement:** show **CONDITIONAL** (pre-existing failure) next to Bob **READY** and **DISAGREEMENT DETECTED**. Say: "evidence over model claims."
7. **Close** on the Bob development evidence: the Bob-authored docs and `.bob/` skills, and the README's "IBM Bob contribution" section.

**Never** say "Bob just completed this" during replay.

## Recommended final repository contents

**Include:**

- `README.md`
- `.env.example`
- `.gitignore`
- `.bob/` (rules and skills)
- `backend/` (`src`, `tests`, `scripts`, `package.json`, `package-lock.json`, `tsconfig.json`, `verify-db.js`)
- `frontend/` (`src`, config files, `package.json`, `package-lock.json`)
- `demo-app/`, including its baseline history (see B2)
- `docs/`: all files, including the Bob-authored planning documents as development evidence

**Exclude:**

- `node_modules/` and `dist/` everywhere
- `backend/data/` and all `*.db*` files
- `.env`
- logs
- `~/.bob` (Bob's local store; personal data, not part of the project)

## Non-blocking issues (not fixed, by instruction)

| ID | Issue |
|---|---|
| N1 | `npm start` in the backend fails: `schema.sql` isn't copied into `dist/`. Use `npm run dev`. |
| N2 | The Bob-authored `ARCHITECTURE.md` / `BOB_WORKFLOW.md` / `IMPLEMENTATION_PLAN.md` describe the original design (`git stash`, `bob -p`, "5 subagents"). They are kept as development evidence and labelled historical in the README. |
| N3 | `.env.example` still lists the unused `BOB_APPROVAL_MODE`, and describes `BOB_CLI_PATH` as the executable path. It also accepts an entry-point path. |
| N4 | `verify-db.js` in the backend doesn't work (it requires TypeScript sources). It isn't used by the demo. |
| N5 | No authentication, and no recovery after a server restart. Replay sessions are lost on restart. |
| N6 | No ForgeGuard mission has been completed with live Bob (credits exhausted). This is stated in the README and docs. |
| N7 | The 5 empty, unattributed Bob task records (#5–#9) in `~/.bob/db/bob.db`. |
