# ForgeGuard

**Evidence-based software-change validation and release readiness, built with IBM Bob 2.0.**
Submission for the IBM Bob 2.0 Hackathon.

Repository: https://github.com/ashuthoshreddy10/forgeguard

## The problem

AI coding agents can change a repository quickly. They are also able to *say* a change is safe without evidence that it is. Teams need a workflow where:

- the agent's work is planned and reviewed before it happens,
- the release decision rests on commands that actually ran, not on what the model claims,
- and every change can be undone safely.

## The solution

ForgeGuard turns an issue or change request into an auditable engineering mission with six phases:

```
Issue / change request
  1. Repository understanding     IBM Bob (ask mode, read-only)      ← baseline validation runs first
  2. Parallel specialist analysis 5 parallel Bob sessions: code impact, tests, security, API, docs
  3. Change plan                  IBM Bob (plan mode) → developer approval gate
  4. Implementation               rollback anchor + repository lock, then IBM Bob (agent mode)
  5. Validation                   ForgeGuard runs lint / test / typecheck / build again
  6. Release report               Bob narrative (advisory)  +  DETERMINISTIC RELEASE DECISION
```

The design rules:

- **Evidence over claims.**
  - Validation commands are run by ForgeGuard, not by Bob.
  - The release verdict (**READY / CONDITIONAL / BLOCKED**) is computed from the stored baseline and post-implementation results.
  - A failure that already existed is kept distinct from a regression.
  - Bob's narrative is shown separately, and can never change the verdict.
  - Details: [docs/RELEASE_VERDICT.md](docs/RELEASE_VERDICT.md).
- **Truthful state.** A failed Bob task fails its phase and the mission, and the later phases are shown as skipped. Nothing is reported as passed unless it ran.
- **Safe rollback.** Before Bob implements, ForgeGuard records a mission-specific Git snapshot. The developer's uncommitted work is preserved, and there is no `git stash`. Details: [docs/ROLLBACK_DESIGN.md](docs/ROLLBACK_DESIGN.md).
- **Guarded execution:**
  - a repository allow-list
  - a server bound to `127.0.0.1`
  - WebSocket and REST Origin checks
  - input limits
  - validation timeouts
  - a Bob availability preflight
  - Details: [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) and [docs/VALIDATION_POLICY.md](docs/VALIDATION_POLICY.md).

## Architecture

```
frontend/   React 18 + Vite + Tailwind + Zustand: operational dashboard (REST = source of truth, WebSocket = change signal)
backend/    Node + Express + ws + SQLite
  src/pipeline/   MissionOrchestrator (6 phases), releaseVerdict, rollback
  src/bob/        BobShellClient: spawns `bob run --mode … -f stream-json` via Node, no shell
  src/git/        mission-specific anchors, repository lock
  src/replay/     Demo Replay Mode: deterministic fixtures, isolated from the pipeline
demo-app/   Target repository: small Express + TS app with 10 intentionally seeded issues
            (tracked here as a normal directory; scripts/setup-demo-repo.mjs makes it its own
            Git repo at the original baseline commit fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f)
scripts/    setup-demo-repo.mjs
.bob/       Bob project rules and skills used during development
docs/       Design documents and the engineering audit trail
```

More detail: [docs/UI_ARCHITECTURE.md](docs/UI_ARCHITECTURE.md), [docs/DEMO_REPLAY.md](docs/DEMO_REPLAY.md), [docs/DEMO_BASELINE.md](docs/DEMO_BASELINE.md).

## Setup

**Prerequisites:** Node.js 22 (developed on v22.20.0, npm 10.9.3) and Git. The IBM Bob Shell CLI (`bobshell` 2.0.x) is needed **only** for live missions; it is not needed for the demo.

```bash
git clone https://github.com/ashuthoshreddy10/forgeguard.git
cd forgeguard
node scripts/setup-demo-repo.mjs     # re-creates demo-app's own Git repo at baseline fc6794e (see below)
cd backend  && npm ci
cd ../frontend && npm ci
cd ../demo-app && npm ci
```

**Why the setup script?** In this repository, `demo-app/` is a normal tracked directory: no submodule, and no `--recursive` clone needed. ForgeGuard, however, operates on demo-app as a mission **target**, and the target must be the top level of its own Git repository, because rollback anchors and the repository lock live there.

`scripts/setup-demo-repo.mjs` re-creates `demo-app/.git` with HEAD at the original baseline commit `fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f`:

- It fetches that exact commit from this repository's history (tag `demo-app-baseline`).
- For a ZIP download without Git history, it rebuilds the commit from the tracked files and verifies the SHA matches.
- It never modifies demo-app's files.
- The nested `demo-app/.git` is local only; Git never tracks it.

Replay Mode and the frontend work without the script. The backend tests, the integration test and live missions need it.

`.env.example` documents every setting. The backend runs without a `.env`. Never commit secrets: `.env` is git-ignored. If you use live Bob, set `BOBSHELL_API_KEY` in your environment.

## Run the demo (no IBM Bob required)

Start both servers in two terminals. Setting `BOB_CLI_PATH` to a file that doesn't exist makes Bob **unavailable**, so nothing can start a paid Bob task during the demo.

```bash
# terminal 1 (bash)
cd backend && BOB_CLI_PATH=/nonexistent/bob.js npm run dev
#   PowerShell: $env:BOB_CLI_PATH='C:\nonexistent\bob.js'; npm run dev

# terminal 2
cd frontend && npm run dev
```

Open **http://localhost:5173**. The backend listens on `127.0.0.1:3001`, and Vite proxies `/api` and `/ws` to it.

Use `npm run dev` for the backend; `npm start` from `dist/` is not supported yet (see [docs/FINAL_SUBMISSION_AUDIT.md](docs/FINAL_SUBMISSION_AUDIT.md)).

### Demo Replay Mode

Open http://localhost:5173 and click **START DEMO REPLAY** (or **Demo replay** in the sidebar), choose a scenario and press **START REPLAY**. Playback pauses at the plan-approval gate; click **Approve plan** to reach the release decision.

| Scenario | What it shows | Final state |
|---|---|---|
| Safe Fix | the complete successful workflow, including approval and rollback | **READY** |
| Regression Blocked | post-change validation exposes a regression | **BLOCKED** |
| Bob Disagreement | Bob's narrative says READY, but the evidence shows a pre-existing failure | **CONDITIONAL** + **DISAGREEMENT DETECTED** |

- **Controls:** Play / Pause, Skip to next, Restart, 1x / 2x / 4x.
- **Approval:** the replay stops at **Waiting for approval**; press **Approve plan** to continue.
- **Rollback:** in Safe Fix, try **Roll back**.
- **Evidence:** open **Evidence** to see the prompts, fixture outputs and the verdict evidence.

**Replay Mode is deterministic fixture data. It never invokes IBM Bob, runs no command, and doesn't touch Git, demo-app or the mission database.**

- Every replay screen carries the banner **DEMO REPLAY — NOT A LIVE BOB RUN**.
- Bob-style text is labelled **SYNTHETIC BOB NARRATIVE**.
- The replay rollback is labelled **NOT A LIVE REPOSITORY ROLLBACK**.
- The verdicts are computed by the same release-verdict code that live missions use.

See [docs/DEMO_REPLAY.md](docs/DEMO_REPLAY.md).

### Live missions

**+ New mission** creates a real mission against demo-app. **Run pipeline** first runs a preflight: the allow-list, Git, lock and Bob availability checks.

- **With Bob unavailable**, as configured above, the UI shows **BOB UNAVAILABLE**, and no phase or Bob task starts.
- **With a working, funded Bob Shell**, the real pipeline runs, and it spends Bob credits.

## Three different things: live integration, development history, replay

| | What it is | Does it run IBM Bob? |
|---|---|---|
| **Live Bob integration** | The real mission pipeline: `BobShellClient` runs `bob run` for phases 1–4 and 6; ForgeGuard itself runs validation (phase 5). | **Yes**, when Bob is installed, authenticated and funded. Not exercised end-to-end for this submission (credits exhausted). |
| **Bob-assisted development history** | IBM Bob 2.0 planned and built the initial ForgeGuard during development. | It already ran, during development. The evidence is described below. |
| **Demo Replay Mode** | Deterministic fixture data rendered through the real UI and release-verdict code. | **No, never.** |

## IBM Bob contribution

**IBM Bob 2.0 was used to build ForgeGuard.** The evidence is kept in Bob Shell's local task store (`~/.bob/db/bob.db`, inspected read-only; not part of this repository) and in the artifacts Bob produced.

- **Bob Shell 2.0.5 development sessions (2026-09-25):**

| Task | Messages | Ended |
|---|---|---|
| Planning | 205 | 100-turn limit |
| One native Bob **subagent** (workspace exploration) | — | — |
| Implementation | 235 | 100-turn limit |
| Final session | 100 | `BudgetExceededError` (credits exhausted) |

  The store also contains a few later task records with no messages.
- **Bob-authored artifacts in this repository.** These are kept unchanged as development evidence. They describe the original plan, and parts are **superseded** by the audited implementation:
  - [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
  - [docs/BOB_WORKFLOW.md](docs/BOB_WORKFLOW.md)
  - [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
  - [docs/AUDIT_FIX_PLAN.md](docs/AUDIT_FIX_PLAN.md)
  - the `.bob/` rules and skills
  - the initial frontend, backend and demo-app

  Superseded examples: the `git stash` rollback, the `bob -p` CLI flags, and "5 subagents".
- **After Bob's credits ran out**, the implementation was audited and hardened with Claude Code: truthful failure states, correct Bob CLI invocation, the deterministic verdict, the rollback redesign, security, the UI and Replay Mode. Every step, command and test result is recorded in [docs/CLAUDE_AUDIT.md](docs/CLAUDE_AUDIT.md).
- **No ForgeGuard mission has been completed with live Bob.** Credits were exhausted before the integration could run end-to-end. The Bob integration is verified against the installed CLI (`--version`, `run --help`) and with a test-only fake entry point. That is why the demo uses Replay Mode.

## IBM Bob task-session evidence

The `bob_sessions/` directory contains the relevant IBM Bob IDE task-session
consumption-summary screenshots from the ForgeGuard development process.

These records document:

- `01_planning_consumption_summary.png` — ForgeGuard planning and architecture work
- `02_implementation_consumption_summary.png` — ForgeGuard implementation work
- `03_final_session_consumption_summary.png` — later Bob development/report session

These are historical Bob development sessions and are not recordings of a
completed live ForgeGuard mission.

The final demonstration uses Demo Replay Mode, which is explicitly labeled
and never invokes IBM Bob.

## Tests

```bash
node scripts/setup-demo-repo.mjs                      # once, if not done yet
cd backend  && npm test && npm run test:integration   # 121 tests + 1 integration test (real demo-app validation)
cd frontend && npm test                               # 38 tests
cd demo-app && npm test                               # 29 tests
```

None of the tests invokes IBM Bob. Bob is replaced by test-only fakes.

## Documentation

| Document | Content |
|---|---|
| [docs/FINAL_SUBMISSION_AUDIT.md](docs/FINAL_SUBMISSION_AUDIT.md) | Final submission audit and exact results |
| [docs/DEMO_REPLAY.md](docs/DEMO_REPLAY.md) | Replay Mode: scenarios, isolation, transparency rules |
| [docs/RELEASE_VERDICT.md](docs/RELEASE_VERDICT.md) | Deterministic release decision |
| [docs/ROLLBACK_DESIGN.md](docs/ROLLBACK_DESIGN.md) | Mission-specific anchors, developer-change preservation, locking |
| [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | Allow-list, binding, origins, input limits |
| [docs/VALIDATION_POLICY.md](docs/VALIDATION_POLICY.md) | Baseline/post validation, timeouts |
| [docs/UI_ARCHITECTURE.md](docs/UI_ARCHITECTURE.md) | Frontend state model |
| [docs/DEMO_BASELINE.md](docs/DEMO_BASELINE.md) | demo-app baseline and seeded issues |
| [docs/CLAUDE_AUDIT.md](docs/CLAUDE_AUDIT.md) | Engineering audit trail (Milestones 1–7) |
| IMPLEMENTATION_PLAN / BOB_WORKFLOW / ARCHITECTURE / AUDIT_FIX_PLAN | Bob-authored planning documents (historical) |
