# ForgeGuard — IBM Bob 2.0 Workflow
## How Bob 2.0 Is Used Throughout Development and Demonstration

> This document describes exactly how IBM Bob 2.0 is used as an engineering partner  
> in ForgeGuard — both during the development of ForgeGuard itself and during the  
> live demonstration of the finished product.

---

## Part 1: Bob's Role in Building ForgeGuard

ForgeGuard is built using Bob 2.0 as the primary engineering partner. Bob is not just  
the product — Bob is used to build the product. This creates a dogfooding narrative  
that is compelling for judges.

### 1.1 Development Workflow

Every feature of ForgeGuard is developed following this Bob-driven workflow:

```
Developer writes a task description
  → Switches to Bob Plan mode
  → Bob analyzes existing code and produces a plan
  → Developer reviews and approves
  → Switches to Bob Agent mode
  → Bob implements the feature
  → Bob runs validation (lint, tests, typecheck)
  → Developer reviews diff
```

### 1.2 Bob Modes Used During Development

| Development Phase | Bob Mode | What Bob Does |
|---|---|---|
| Architecture design | Plan | Proposes component structure, data model |
| Scaffolding | Agent | Creates files, package.json, tsconfig |
| Demo-app creation | Agent | Writes pricing.ts, utils.ts, test files |
| Skill file authoring | Plan | Drafts specialist prompt content |
| Backend pipeline code | Agent | Implements PipelineController, phases |
| Frontend components | Agent | Builds React components, Zustand store |
| Integration debugging | Agent | Fixes wiring bugs between frontend/backend |
| Documentation | Agent | Writes DEMO_RUNBOOK.md, PITCH.md |

### 1.3 Bob Capabilities Exercised During Development

- **Plan mode** — Used before every non-trivial implementation to ensure the right  
  approach is chosen
- **Agent mode** — Used for all code writing and file creation
- **Subagents** — Used to explore different parts of the codebase in parallel when  
  debugging integration issues
- **Rules** — `.bob/RULES.md` keeps Bob's output consistent and evidence-based
- **Skills** — The 7 ForgeGuard skill files are authored and refined in collaboration  
  with Bob
- **Repository-aware reasoning** — Bob reads actual files before making any claim  
  about the codebase
- **Testing** — Bob runs `npm test` and reports actual output, never fabricates results
- **Rollback** — Git branches used before risky refactors; Bob creates them

---

## Part 2: Bob's Role in the ForgeGuard Product

Bob 2.0 is the reasoning engine of ForgeGuard. Every analysis, plan, and code change  
in a ForgeGuard run is produced by Bob. The backend is an orchestration layer around Bob.

### 2.1 Pipeline Phase Map

```
┌─────────────────────────────────────────────────────────────────┐
│  FORGEGUARD PIPELINE                                            │
│                                                                  │
│  Phase 1: Repository Understanding                               │
│  ┌─────────────────────────────────────────────────────┐        │
│  │  Bob — Plan mode                                     │        │
│  │  Skill: repo-understander.md                        │        │
│  │  Input:  directory listing + file contents          │        │
│  │  Output: RepoSummary JSON                           │        │
│  └─────────────────────────────────────────────────────┘        │
│                           │                                      │
│                           ▼                                      │
│  Phase 2: Parallel Specialist Analysis                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────┐ │
│  │Code      │ │Test      │ │Security  │ │API       │ │Doc    │ │
│  │Impact    │ │Engineer  │ │Analyst   │ │Compat    │ │Analyst│ │
│  │Plan mode │ │Plan mode │ │Plan mode │ │Plan mode │ │Plan   │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └───────┘ │
│       ↓            ↓            ↓             ↓           ↓      │
│  ImpactJSON   TestJSON    SecurityJSON  CompatJSON   DocJSON     │
│                           │                                      │
│                           ▼                                      │
│  Phase 3: Change Plan Synthesis                                  │
│  ┌─────────────────────────────────────────────────────┐        │
│  │  Bob — Plan mode                                     │        │
│  │  Input:  all 5 specialist reports                   │        │
│  │  Output: ChangePlan JSON                            │        │
│  └─────────────────────────────────────────────────────┘        │
│                           │                                      │
│               ← Developer Approval Gate →                        │
│                           │                                      │
│  Phase 4: Implementation                                         │
│  ┌─────────────────────────────────────────────────────┐        │
│  │  Bob — Agent mode                                    │        │
│  │  Input:  ChangePlan + repo context                  │        │
│  │  Output: Modified files + implementation summary    │        │
│  └─────────────────────────────────────────────────────┘        │
│                           │                                      │
│  Phase 5: Validation                                             │
│  ┌─────────────────────────────────────────────────────┐        │
│  │  Bob — Agent mode                                    │        │
│  │  Runs: npm run lint, npm test, npm run typecheck    │        │
│  │  Output: ValidationResult JSON (verbatim output)   │        │
│  └─────────────────────────────────────────────────────┘        │
│                           │                                      │
│  Phase 6: Release Readiness Report                               │
│  ┌─────────────────────────────────────────────────────┐        │
│  │  Bob — Plan mode                                     │        │
│  │  Skill: release-engineer.md                         │        │
│  │  Input:  ChangePlan + ValidationResult + all reports│        │
│  │  Output: ReleaseReport JSON                         │        │
│  └─────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

---

### 2.2 Phase 1 — Repository Understanding

**Bob mode:** Plan  
**Skill loaded:** `skills/repo-understander.md`

**What happens:**
1. Backend reads the `demo-app/` directory tree and key file contents
2. Constructs a prompt: repo structure + issue description + skill instructions
3. Invokes Bob in Plan mode
4. Bob produces a structured `RepoSummary`:
   - Tech stack identified
   - Entry points listed
   - Module responsibilities mapped
   - Dependencies noted
   - Test framework identified
   - Key files relevant to the issue highlighted

**Evidence captured:**
- Full prompt text
- Full Bob response text
- Extracted RepoSummary JSON
- Bob session ID

**Bob capabilities demonstrated:**
- Repository-aware reasoning (Bob reads actual files)
- Plan mode structured output
- Skill loading

---

### 2.3 Phase 2 — Parallel Specialist Analysis

**Bob mode:** Plan (×5 simultaneous sessions)  
**Skills loaded:** One per specialist

**What happens:**
1. Backend launches 5 Bob Plan-mode sessions simultaneously (Promise.all)
2. Each session receives:
   - The specialist skill file as system context
   - The RepoSummary from Phase 1
   - The original issue text
   - Instructions to return structured JSON findings
3. All 5 sessions run in parallel
4. Results are collected as each session completes

**Individual specialist behaviors:**

#### Code Impact Analyst
Skill: `skills/code-impact-analyst.md`
- Identifies which files and functions are directly changed
- Traces call graphs to find indirect impacts
- Estimates change scope: small / medium / large
- Returns: `{ affectedFiles, callGraph, changeScope, blastRadius }`

#### Test Engineer
Skill: `skills/test-engineer.md`
- Finds existing tests that cover affected code
- Identifies paths with no test coverage (test gaps)
- Recommends new test cases by name and description
- Returns: `{ coveredBy, gaps, recommendedTests }`

#### Security Analyst
Skill: `skills/security-analyst.md`
- Checks if the change touches security-sensitive areas
- Maps to OWASP Top 10 where applicable
- Returns: `{ findings: [{ severity, description, location, owaspRef }] }`

#### API/Compatibility Analyst
Skill: `skills/api-compat-analyst.md`
- Identifies all public API surfaces in the affected files
- Classifies each change as breaking / non-breaking
- Recommends semver bump
- Returns: `{ publicApis, breakingChanges, semverRecommendation }`

#### Documentation Analyst
Skill: `skills/doc-analyst.md`
- Finds doc files referencing affected components
- Flags stale or missing documentation
- Returns: `{ docFiles, staleRefs, missingDocs }`

**Evidence captured per specialist:**
- Full prompt sent
- Full response received
- Extracted JSON report
- Session start time, completion time (for parallel timing display)
- Bob session ID

**Bob capabilities demonstrated:**
- Subagents (5 independent Bob sessions)
- Parallel workstreams (all 5 running simultaneously)
- Specialized skills per domain
- Structured JSON output
- Independent reasoning contexts

---

### 2.4 Phase 3 — Change Plan Synthesis

**Bob mode:** Plan  
**No specialist skill (uses PlanSynthesizer prompt template)**

**What happens:**
1. Backend assembles all 5 specialist reports + RepoSummary + issue text
2. Invokes Bob in Plan mode
3. Bob synthesizes a unified ChangePlan:
   - Summary of what will change and why
   - Ordered list of file changes with descriptions
   - Test cases to add (from TestEngineer report)
   - Security considerations (from SecurityAnalyst report)
   - Compatibility notes (from ApiCompatAnalyst report)
   - Documentation updates needed (from DocAnalyst report)
   - Overall risk level: low / medium / high
   - Confidence score

**Evidence captured:**
- Aggregated input (all reports)
- Full Bob response
- Extracted ChangePlan JSON

**Bob capabilities demonstrated:**
- Cross-domain synthesis
- Structured output following ForgeGuard rules
- Risk assessment reasoning

---

### 2.5 Developer Approval Gate

**Bob mode:** N/A (human decision point)

The developer reviews the ChangePlan in the UI:
- Risk badge (green/amber/red)
- Affected files list with change descriptions
- Findings from each specialist (collapsible)
- Approve or Request Revision buttons

If the developer requests revision, they can annotate the plan and re-trigger Phase 3.

---

### 2.6 Phase 4 — Implementation

**Bob mode:** Agent  
**No skill (uses Implementer prompt template)**

**What happens:**
1. Backend constructs an implementation prompt from the approved ChangePlan
2. Creates a git rollback point: `git stash` (stores stash ref in Run record)
3. Invokes Bob in Agent mode with the demo-app/ as working directory
4. Bob reads affected files, makes the changes described in the plan
5. Bob returns a summary of every file it changed

**Prompt structure:**
```
You are implementing an approved change plan for the ForgeGuard system.
The change plan is: [ChangePlan JSON]
The repository is at: demo-app/
Rules: [ForgeGuard RULES.md content]

Make exactly the changes described in the plan. No more, no less.
After each file change, output a summary line:
CHANGED: <filepath> — <one-line description>
When complete, output:
IMPLEMENTATION COMPLETE
```

**Evidence captured:**
- Implementation prompt
- Every file diff produced by Bob
- Bob's tool call log (file reads, file writes)
- CHANGED summary lines
- Git stash reference (rollback anchor)

**Bob capabilities demonstrated:**
- Agent mode file editing
- Repository-aware code changes
- Minimal-change discipline (ForgeGuard rules enforced)
- Rollback anchor creation
- Tool call execution (file reads/writes)

---

### 2.7 Phase 5 — Validation

**Bob mode:** Agent  
**No skill (uses Validator prompt template)**

**What happens:**
1. Bob is invoked in Agent mode to run validation commands
2. Bob executes each command and captures verbatim output:
   ```bash
   cd demo-app && npm run lint
   cd demo-app && npm test
   cd demo-app && npm run typecheck
   ```
3. Bob parses results into ValidationResult JSON
4. If tests fail, Bob produces a diagnosis: which tests failed and why

**Evidence captured:**
- Full stdout/stderr for each command (verbatim — never paraphrased)
- Pass/fail per test case
- Lint error list (if any)
- Type errors (if any)
- Bob's failure diagnosis (if validation failed)

**Bob capabilities demonstrated:**
- Agent mode command execution
- Evidence over claims (verbatim output captured)
- Failure diagnosis
- Structured result extraction

**Failure handling:**
If validation fails, ForgeGuard displays:
- Which tests failed (specific test names)
- Bob's diagnosis of the failure
- Option to re-trigger implementation with the diagnosis as additional context
- Rollback button remains available

---

### 2.8 Phase 6 — Release Readiness Report

**Bob mode:** Plan  
**Skill loaded:** `skills/release-engineer.md`

**What happens:**
1. Backend assembles: ChangePlan + ValidationResult + all 5 specialist reports
2. Invokes Bob in Plan mode with release-engineer skill
3. Bob produces the final ReleaseReport:
   - Readiness status: ready / conditional / not-ready
   - Risk assessment narrative
   - Open items (any unresolved findings)
   - List of all changed files
   - Rollback availability confirmation
   - Evidence references (links to stored EvidenceItems)

**Evidence captured:**
- Aggregated input (all reports + validation)
- Full Bob response
- Extracted ReleaseReport JSON

**Bob capabilities demonstrated:**
- End-to-end workflow awareness
- Evidence-based reasoning (cites actual test output, actual findings)
- Release gate decision-making
- Skill-driven structured output

---

## Part 3: Bob Rules in Effect

The file `.bob/RULES.md` is loaded for all Bob sessions in this project.

### Why rules matter for the demo

Rules ensure that Bob's output is consistent, auditable, and credible. In a live demo,  
a judge who sees Bob's raw output should immediately notice:

1. **Structured output** — JSON blocks are clearly delimited
2. **Evidence citations** — Every claim references a file:line or command output
3. **Fact vs. recommendation separation** — "OBSERVED:" vs. "RECOMMENDATION:"
4. **Minimal changes** — Bob never adds features that weren't asked for
5. **Verbatim output** — Validation results are never paraphrased

### Rule file: `.bob/RULES.md`

```markdown
## ForgeGuard Rules

1. EVIDENCE OVER CLAIMS — Never say a test passed unless the actual test runner output
   is included. Never fabricate file contents, test names, or analysis results.

2. STRUCTURED OUTPUT — When asked to produce JSON, wrap it in:
   --- FORGEGUARD:JSON ---
   { ... }
   --- END ---
   Do not add commentary inside the JSON block.

3. SEPARATE FACTS FROM RECOMMENDATIONS — Use "OBSERVED:" for things seen in the code
   and "RECOMMENDATION:" for AI suggestions. Never blend them.

4. MINIMAL CHANGES — Make the smallest change that solves the problem. Do not refactor
   unrelated code. Do not add unrequested features.

5. REPRODUCIBILITY — Always include the exact commands run and their full output.
   Never paraphrase command output.

6. AUDIT TRAIL — Begin every response with a one-line summary of what was done,
   followed by evidence.

7. NO OVER-ENGINEERING — Do not propose abstractions, design patterns, or architectural
   changes unless the issue explicitly requires them.

8. ROLLBACK AWARENESS — Before modifying any file, confirm the rollback reference
   (git stash or branch) is established.
```

---

## Part 4: Bob Skills Used in the Product

Each Bob specialist session loads a skill file. Skills are focused system prompts  
that give the Bob session its domain expertise and output format requirements.

| Skill File | Loaded By | Purpose |
|---|---|---|
| `skills/repo-understander.md` | Phase 1 | Maps the repository structure |
| `skills/code-impact-analyst.md` | Phase 2 | Analyzes code change blast radius |
| `skills/test-engineer.md` | Phase 2 | Finds test gaps and recommends tests |
| `skills/security-analyst.md` | Phase 2 | Security review of the change |
| `skills/api-compat-analyst.md` | Phase 2 | API breaking change detection |
| `skills/doc-analyst.md` | Phase 2 | Documentation coverage analysis |
| `skills/release-engineer.md` | Phase 6 | Release readiness assessment |

Skills are designed to be:
- **Focused** — one domain, one output format
- **Prescriptive** — exact JSON schema specified in the skill
- **Honest** — rules about what Bob can and cannot claim
- **Reusable** — the same skill works on any JavaScript/TypeScript repo

---

## Part 5: Evidence Trail for Judges

Every ForgeGuard run produces a complete evidence trail stored in the SQLite database  
and displayed in the Evidence Drawer in the UI.

### Evidence types

| Type | Description | Phase |
|---|---|---|
| `repo-summary` | Bob's structured understanding of the repo | Phase 1 |
| `impact-report` | Code impact analysis JSON | Phase 2 |
| `test-report` | Test gap analysis JSON | Phase 2 |
| `security-report` | Security findings JSON | Phase 2 |
| `compat-report` | Compatibility analysis JSON | Phase 2 |
| `doc-report` | Documentation analysis JSON | Phase 2 |
| `change-plan` | Synthesized change plan JSON | Phase 3 |
| `implementation-diff` | Exact file diffs written by Bob | Phase 4 |
| `bob-tool-calls` | File reads/writes Bob performed | Phase 4 |
| `lint-output` | Verbatim ESLint stdout/stderr | Phase 5 |
| `test-output` | Verbatim Vitest stdout/stderr | Phase 5 |
| `typecheck-output` | Verbatim tsc stdout/stderr | Phase 5 |
| `release-report` | Final release readiness report | Phase 6 |
| `rollback-ref` | Git stash hash for rollback | Phase 4 |
| `session-ids` | Bob session ID for every phase | All |

### What judges can verify

1. **Every Bob prompt is visible** — judges can see exactly what was asked
2. **Every Bob response is visible** — judges can verify Bob actually did the work
3. **Test results are verbatim** — no "tests passed" claims without runner output
4. **Diffs are exact** — every changed line is shown
5. **Timing is recorded** — parallel analysis durations prove parallel execution
6. **Session IDs are stored** — each Bob session is traceable
7. **Rollback is real** — the git stash ref is shown and can be executed

---

## Part 6: Demo Script

This is the exact flow used during the live demonstration.

### Pre-demo setup (5 minutes before)

1. Start backend: `cd backend && npm run dev`
2. Start frontend: `cd frontend && npm run dev`
3. Open browser to `http://localhost:5173`
4. Verify demo-app/ is in a clean git state: `cd demo-app && git status`
5. Have Evidence Drawer open in a side panel

### Demo walkthrough (8–10 minutes)

**[0:00] Open the UI**
- Show the engineering control-center layout
- Point out: "This is not a chatbot. This is a structured engineering workflow."

**[0:30] Load Scenario A**
- Click "Quick Load: Bug Fix"
- Show the issue text: calculateDiscount() clamping bug

**[1:00] Click Analyze**
- Phase 1 starts: "Bob is analyzing the repository in Plan mode"
- Show the Evidence Drawer opening: "Every Bob prompt is recorded here"
- Show Bob's repo summary arriving in real time

**[2:00] Parallel analysis begins**
- Show the 5 cards appearing simultaneously
- Point out: "These are 5 independent Bob sessions running in parallel"
- Watch timers counting up on each card
- Cards complete at different times (demonstrating true parallelism)

**[3:30] Change Plan arrives**
- Show the ChangePlan panel
- Point out risk level badge, affected files
- Open one specialist accordion: show Security findings with OBSERVED/RECOMMENDATION separation
- "Bob separated what it observed from what it recommends"

**[4:30] Click Approve Plan**

**[5:00] Implementation begins**
- Show file diffs appearing in the ImplementationFeed
- "Bob is writing code in Agent mode"
- Show git stash ref in Evidence Drawer: "Rollback is ready"

**[6:00] Validation runs**
- Show lint, test, typecheck commands running
- Show verbatim test output: specific test names, pass/fail
- "We never say 'tests passed' without showing you the actual output"

**[7:00] Release Readiness Report**
- Show the release report: Ready, Low Risk, green badge
- Open evidence refs: "Every claim in this report traces to a specific Bob output"

**[7:30] Demonstrate rollback**
- Click Rollback
- Show git stash pop completing
- Show demo-app back to original state
- "One click. Fully reversible."

**[8:00] Show Evidence Drawer**
- Scroll through all 14+ evidence items
- "This is the complete audit trail for this change"
- "Every Bob session ID, every prompt, every response, every test result"

**[8:30] Close**
- "ForgeGuard transforms an issue into a release decision in under 10 minutes"
- "Bob 2.0 is the reasoning engine. Every analysis, every code change, every validation."

---

## Part 7: Bob Capabilities Checklist

This checklist documents every IBM Bob 2.0 capability demonstrated by ForgeGuard.

| Capability | Where Demonstrated | Evidence |
|---|---|---|
| Plan mode | Phases 1, 2, 3, 6 | Prompt logs show mode selection |
| Agent mode | Phases 4, 5 | File diffs, command output |
| Subagents | Phase 2 (×5) | 5 simultaneous sessions |
| Parallel workstreams | Phase 2 | 5 cards with independent timers |
| Repository-aware reasoning | Phases 1, 4 | Bob reads actual files before acting |
| Document understanding | Phase 2 DocAnalyst | Bob reads README.md and doc files |
| Rules | All phases | RULES.md loaded in every session |
| Skills | Phases 1, 2, 6 | 7 specialist skill files |
| Structured output | All phases | FORGEGUARD:JSON blocks |
| Rollback / safe experimentation | Phase 4 | Git stash before every implementation |
| Testing and validation | Phase 5 | Verbatim test runner output |
| Task/session evidence | All phases | 14+ evidence types per run |
| Failure diagnosis | Phase 5 (on failure) | Bob analyzes failing tests |
| Minimal change discipline | Phase 4 | Rules enforce no unnecessary changes |
| Audit trail | All phases | Session IDs, timestamps, full prompts |
