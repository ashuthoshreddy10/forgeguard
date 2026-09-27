-- ForgeGuard SQLite schema
-- Version: 1
-- Created: initial

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Missions ─────────────────────────────────────────────────────────────────
-- A Mission is one end-to-end ForgeGuard run for a given issue/change request.
CREATE TABLE IF NOT EXISTS missions (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status        TEXT NOT NULL DEFAULT 'created'
                  CHECK(status IN ('created','analyzing','planning','awaiting_approval',
                                   'implementing','validating','complete','failed','rolled_back')),
  issue_text    TEXT NOT NULL,
  repo_path     TEXT NOT NULL,
  -- JSON blob produced by the RepoUnderstander phase
  repo_summary  TEXT,
  -- JSON blob of the approved ChangePlan
  change_plan   TEXT,
  plan_approved INTEGER NOT NULL DEFAULT 0 CHECK(plan_approved IN (0, 1)),
  -- JSON blob of the ValidationResult
  validation_result TEXT,
  -- JSON blob of the final ReleaseReport
  release_report TEXT,
  -- Git stash ref or branch name created before implementation
  rollback_ref  TEXT,
  error_message TEXT
);

-- ─── Pipeline phases ──────────────────────────────────────────────────────────
-- Each phase represents one logical step in the ForgeGuard pipeline.
CREATE TABLE IF NOT EXISTS pipeline_phases (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  phase_name  TEXT NOT NULL
                CHECK(phase_name IN ('repo_understanding','parallel_analysis',
                                     'change_plan','implementation',
                                     'validation','release_report')),
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','running','completed','failed','skipped')),
  started_at  TEXT,
  completed_at TEXT,
  error_message TEXT,
  -- Free-form JSON output for this phase
  output      TEXT
);

-- ─── Agent tasks ──────────────────────────────────────────────────────────────
-- Each Bob invocation is an agent task belonging to a pipeline phase.
CREATE TABLE IF NOT EXISTS agent_tasks (
  id            TEXT PRIMARY KEY,
  phase_id      TEXT NOT NULL REFERENCES pipeline_phases(id) ON DELETE CASCADE,
  mission_id    TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_type     TEXT NOT NULL,  -- e.g. 'repo_understander', 'code_impact_analyst'
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','running','completed','failed','timed_out')),
  bob_provider  TEXT NOT NULL DEFAULT 'shell' CHECK(bob_provider IN ('shell','api')),
  bob_mode      TEXT NOT NULL DEFAULT 'plan' CHECK(bob_mode IN ('plan','agent','ask','code')),
  workspace     TEXT NOT NULL,
  -- Full prompt sent to Bob
  prompt        TEXT,
  -- Full raw response from Bob
  raw_response  TEXT,
  -- Extracted structured output (JSON)
  structured_output TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  duration_ms   INTEGER,
  error_message TEXT
);

-- ─── Evidence ─────────────────────────────────────────────────────────────────
-- Immutable record of every significant interaction, output, or observation
-- produced during a mission. Supports the audit trail shown in the Evidence Drawer.
CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  phase_name  TEXT NOT NULL,
  evidence_type TEXT NOT NULL
                  CHECK(evidence_type IN ('prompt','response','tool_call','structured_output',
                                         'command_output','observation','error')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Optional: file path this evidence relates to
  related_file TEXT
);

-- ─── Artifacts ────────────────────────────────────────────────────────────────
-- Files or diffs produced during a mission (implementation diffs, reports, etc.)
CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
  artifact_type TEXT NOT NULL
                  CHECK(artifact_type IN ('diff','report','file','log')),
  name        TEXT NOT NULL,
  -- File path or identifier
  path        TEXT,
  -- Content of the artifact (for small artifacts; large ones may use path only)
  content     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─── Validation runs ──────────────────────────────────────────────────────────
-- Records of actual test/lint/typecheck command executions.
-- Every claim of "tests passed" must trace to a row in this table.
CREATE TABLE IF NOT EXISTS validation_runs (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  phase_id      TEXT REFERENCES pipeline_phases(id) ON DELETE SET NULL,
  -- 'baseline' = run before implementation, 'post' = run after implementation (Phase 5)
  run_kind      TEXT NOT NULL DEFAULT 'post' CHECK(run_kind IN ('baseline','post')),
  command       TEXT NOT NULL,          -- exact command run
  exit_code     INTEGER,
  stdout        TEXT,                   -- verbatim stdout
  stderr        TEXT,                   -- verbatim stderr
  passed        INTEGER CHECK(passed IN (0, 1)),
  -- 1 = killed after FORGEGUARD_VALIDATION_TIMEOUT_MS (exit_code is then NULL, passed 0)
  timed_out     INTEGER NOT NULL DEFAULT 0 CHECK(timed_out IN (0, 1)),
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at  TEXT,
  duration_ms   INTEGER
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pipeline_phases_mission ON pipeline_phases(mission_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_phase       ON agent_tasks(phase_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_mission     ON agent_tasks(mission_id);
CREATE INDEX IF NOT EXISTS idx_evidence_mission        ON evidence(mission_id);
CREATE INDEX IF NOT EXISTS idx_evidence_task           ON evidence(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_mission       ON artifacts(mission_id);
CREATE INDEX IF NOT EXISTS idx_validation_mission      ON validation_runs(mission_id);
