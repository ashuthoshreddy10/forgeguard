# ForgeGuard — Architecture

## Overview

ForgeGuard is an AI-powered software-change validation and release-readiness platform.
IBM Bob 2.0 is the reasoning engine at every stage of the pipeline.

```
┌─────────────────────────────────────────────────────────────────┐
│                 Browser — React Control Center                   │
│  Sidebar · Pipeline Stepper · Parallel Analysis Grid             │
│  Execution Timeline · Evidence Drawer · Release Report           │
└───────────────────────┬─────────────────────────────────────────┘
                         │ REST + WebSocket (ws://)
┌───────────────────────▼─────────────────────────────────────────┐
│               ForgeGuard Backend — Node.js / Express             │
│                                                                  │
│  PipelineController (future) · TaskManager · EventBus            │
│  MissionsRouter · HealthRouter                                   │
│  BobClient (interface)                                           │
│    ├─ BobShellClient (primary)                                   │
│    └─ BobApiClient   (fallback)                                  │
│  StreamParser · EvidenceCapture                                  │
│  SQLite Database (better-sqlite3)                                │
└────┬───────────────────────────────┬────────────────────────────┘
     │ Bob Shell CLI (bob -p ...)     │ File System
     │                                │
┌────▼───────────────┐  ┌────────────▼───────────────────────────┐
│   IBM Bob 2.0       │  │  demo-app/  (target codebase)           │
│   Plan mode         │  │  src/pricing.ts  (seeded bug)           │
│   Agent mode        │  │  src/utils.ts    (seeded stub)          │
│   Subagents         │  │  src/inventory.ts                       │
└────────────────────┘  │  src/api.ts      (seeded security gap)  │
                         │  tests/                                  │
                         └────────────────────────────────────────┘
```

---

## Components

### Frontend (`frontend/`)

| Component | Purpose |
|---|---|
| `App.tsx` | Root layout, WebSocket init, mission creation |
| `Sidebar.tsx` | Mission history, new mission button, WS indicator |
| `Dashboard.tsx` | Main control-center view for active mission |
| `PipelineStepper.tsx` | 6-step progress indicator |
| `ParallelAnalysisGrid.tsx` | 5 specialist agent cards (Phase 2) |
| `ExecutionTimeline.tsx` | Chronological event log |
| `EvidenceDrawer.tsx` | Full Bob audit trail (prompts, responses, artifacts) |
| `NewMissionModal.tsx` | Issue submission form with Quick Load scenarios |
| `StatusBadge.tsx` | Reusable colored status pill |
| `store/store.ts` | Zustand state management |
| `hooks/useWebSocket.ts` | WebSocket connection + event routing |
| `types.ts` | TypeScript type definitions mirroring backend model |

### Backend (`backend/`)

| Module | Purpose |
|---|---|
| `server.ts` | Express + HTTP server entry point |
| `db/database.ts` | SQLite singleton, schema init |
| `db/schema.sql` | Database schema (6 tables) |
| `bob/BobClient.ts` | Provider-agnostic interface + factory |
| `bob/BobShellClient.ts` | Bob Shell CLI implementation |
| `bob/BobApiClient.ts` | Bob REST API implementation (skeleton) |
| `bob/TaskManager.ts` | Task lifecycle, DB persistence |
| `bob/StreamParser.ts` | JSON block extraction from Bob output |
| `ws/EventBus.ts` | WebSocket server, broadcast infrastructure |
| `ws/events.ts` | Typed event definitions |
| `routes/missions.ts` | Mission CRUD + evidence queries |
| `routes/health.ts` | Health check + Bob availability check |

### Demo Application (`demo-app/`)

| File | Purpose |
|---|---|
| `src/pricing.ts` | Discount calculation (seeded bug #1) |
| `src/utils.ts` | Utilities (seeded stub #4, security gap #5) |
| `src/inventory.ts` | Stock management (seeded mutation issue #7) |
| `src/api.ts` | Express API (seeded validation gap #9) |
| `tests/pricing.test.ts` | Pricing tests (missing boundary cases #2) |
| `tests/utils.test.ts` | Utils tests (missing HTML injection test) |
| `tests/inventory.test.ts` | Inventory tests (missing negative stock test #8) |

---

## Database Schema

Six tables, designed to support the full ForgeGuard workflow:

```
missions           — one row per ForgeGuard run
  └── pipeline_phases  — one row per pipeline phase
        └── agent_tasks    — one row per Bob invocation
              └── evidence      — immutable prompt/response/output records
              └── artifacts     — diffs, reports, generated files
  └── validation_runs    — verbatim test/lint/typecheck command results
```

See [`backend/src/db/schema.sql`](../backend/src/db/schema.sql) for the full schema.

---

## Data Flow

### Creating a Mission

```
1. POST /api/missions { issueText, repoPath }
2. Backend inserts mission row (status: 'created')
3. Backend broadcasts mission.created via WebSocket
4. Frontend receives event, updates sidebar
```

### Pipeline Execution (future Milestone 2)

```
1. POST /api/missions/:id/start
2. PipelineController creates pipeline_phase rows
3. Phase 1: TaskManager invokes BobShellClient (Plan mode, repo-understander skill)
   → agent_task row inserted
   → evidence rows inserted (prompt, response)
   → EventBus broadcasts phase.started, agent.output (streaming), phase.completed
4. Phase 2: 5 BobShellClient invocations in parallel (Promise.all)
   → 5 agent_task rows
   → EventBus broadcasts agent.started × 5, agent.output × N (streaming), agent.completed × 5
5. Phase 3: BobShellClient synthesizes ChangePlan
   → EventBus broadcasts plan.ready
6. Developer approves via PATCH /api/missions/:id/approve
7. Phase 4: BobShellClient (Agent mode) writes code
   → git stash before, rollback_ref stored in mission row
8. Phase 5: ValidationRuns (lint, test, typecheck) → verbatim output stored
9. Phase 6: BobShellClient produces ReleaseReport
10. EventBus broadcasts mission.completed
```

---

## WebSocket Events

All events are broadcast from backend to frontend. Clients may filter by missionId.

| Event | When | Key Payload Fields |
|---|---|---|
| `mission.created` | Mission row inserted | missionId, issueText |
| `mission.updated` | Mission status changes | status, message |
| `mission.completed` | Pipeline finishes | releaseReadiness, summary |
| `mission.failed` | Unrecoverable error | error |
| `phase.started` | Pipeline phase begins | phaseId, phaseName |
| `phase.completed` | Pipeline phase ends | phaseId, durationMs |
| `phase.failed` | Phase error | phaseId, error |
| `agent.started` | Bob task begins | taskId, taskType, bobMode |
| `agent.output` | Streaming Bob output | taskId, chunk |
| `agent.completed` | Bob task finishes | taskId, durationMs, success |
| `agent.failed` | Bob task error | taskId, error |
| `validation.started` | Lint/test command begins | command |
| `validation.completed` | Lint/test command ends | command, exitCode, passed |
| `evidence.created` | New evidence item | evidenceId, evidenceType, preview |
| `plan.ready` | ChangePlan synthesized | changePlan |
| `rollback.completed` | Rollback executed | rollbackRef, message |
| `system.error` | Backend error | error |

---

## Bob Integration

### Primary: Bob Shell CLI

ForgeGuard invokes Bob Shell non-interactively:

```bash
bob -p "<prompt>" \
    --auth-method api-key \
    --chat-mode plan \
    --hide-intermediary-output \
    --approval-mode auto_edit
```

Authentication: `BOBSHELL_API_KEY` environment variable.

### Output Parsing

Bob responses containing structured data use the ForgeGuard JSON protocol:

```
--- FORGEGUARD:JSON ---
{ "taskType": "...", ... }
--- END ---
```

`StreamParser.extractJsonBlock()` extracts and parses these blocks.

### Provider Selection

```
BOB_PROVIDER=shell  → BobShellClient (primary, default)
BOB_PROVIDER=api    → BobApiClient   (fallback, stub)
```

---

## Security Considerations

- Bob credentials (`BOBSHELL_API_KEY`) are read only from environment variables, never from config files
- No secrets are ever logged or returned to the frontend
- Bob Shell only runs in the configured `BOB_WORKSPACE` directory (the demo-app)
- `--approval-mode auto_edit` is only set for implementation tasks where file writes are required
- Without `--approval-mode auto_edit`, Bob Shell defaults to non-destructive (read-only) tools
- The database stores full Bob prompts/responses — ensure these are not accessible without auth in production (auth is out of scope for the hackathon MVP)

---

## Future Pipeline Phases (Milestone 2+)

```
PHASE 1  Repository Understanding     — Bob Plan mode, repo-understander skill
PHASE 2  Parallel Specialist Analysis — 5x Bob Plan mode in parallel
PHASE 3  Change Plan Synthesis        — Bob Plan mode
         Developer Approval Gate
PHASE 4  Implementation               — Bob Agent mode, --approval-mode auto_edit
PHASE 5  Validation                   — Bob Agent mode, runs lint/test/typecheck
PHASE 6  Release Report               — Bob Plan mode, release-readiness skill
```
