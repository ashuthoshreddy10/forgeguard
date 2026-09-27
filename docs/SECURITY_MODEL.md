# Security Model

ForgeGuard runs `npm` scripts and a write-enabled AI agent inside a repository. Anyone who can start a mission can therefore execute code on the machine.

The model is: **local tool, loopback only, fixed repositories, browser origins allow-listed**. There is no user authentication. Designing one was out of scope.

Configuration is in `backend/src/config.ts` and `backend/src/security/repoPolicy.ts`. Tests are in `backend/tests/security.test.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `FORGEGUARD_HOST` | `127.0.0.1` | interface to bind to |
| `FORGEGUARD_ALLOWED_REPOS` | the bundled `demo-app` | allowed repositories: absolute paths separated by the platform path delimiter (`;` on Windows, `:` elsewhere) |
| `FORGEGUARD_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | browser origins allowed for REST and WebSocket. Comma-separated. `*` is never accepted. |
| `FORGEGUARD_VALIDATION_TIMEOUT_MS` | `180000` | per validation command (see `VALIDATION_POLICY.md`) |

## S1 — Repository allow-list

A mission's `repoPath` decides where `npm` scripts and Bob run. Only allow-listed repositories are accepted.

- **Canonical comparison:**
  - Every allowed entry and every requested path goes through `fs.realpathSync.native`, which resolves `..`, symlinks, junctions and 8.3 short names.
  - The requested path must then **equal** an allowed repository (case-insensitive on Windows).
  - There's no string-prefix check. `C:\repos\app-evil` doesn't match `C:\repos\app`, and neither does a subdirectory of an allowed repository.
- **Rejected:** relative paths, non-strings, NUL bytes, paths over 1024 characters, paths that don't exist, and links that point outside. Allow-list entries that are relative or missing are ignored, with a warning.
- **Default:** only `demo-app`. Omitting `repoPath`, or sending an empty one, selects the first allowed repository.
- **Where it's enforced:**
  - `POST /api/missions`: 403 `REPO_NOT_ALLOWED` or 400 `INVALID_REPO_PATH`. The canonical path is what gets stored.
  - `POST /api/missions/:id/start` checks again, which catches missions stored before this change (such as the audit's `C:/Windows` mission). It answers 403 and fails the mission with `preflight` error evidence.
  - Rollback checks again too.
- **No path disclosure:** error messages never echo the requested or resolved path.
- **Git requirements:** the repository must be the top level of its own Git repository with at least one commit. Otherwise it's refused with 422 `REPO_NOT_GIT` at start, or `NO_COMMITS` before implementation.

## S2 — Server binding

- The server listens on `127.0.0.1` unless `FORGEGUARD_HOST` says otherwise.
- It never falls back to `0.0.0.0` silently. A non-default host logs a warning at startup.
- The Vite dev proxy targets `127.0.0.1:3001`, so it doesn't depend on how `localhost` resolves.
- Verified live: `netstat` shows only `127.0.0.1:3001 LISTENING`.

## S3 — Origin policy

- **WebSocket (`/ws`):** checked by `verifyClient` during the upgrade.
  - An allow-listed `Origin` is accepted.
  - Any other `Origin`, including `null`, is rejected with **403** before any event is sent.
  - A **missing** Origin is accepted. Browsers always send `Origin` on a WebSocket handshake, so no website can connect without one. Non-browser clients (the scripted flow used in the audit, test harnesses) don't send one, and they could forge any value anyway. The control for those is the loopback bind.
- **REST:**
  - CORS allows only the allow-listed origins.
  - CORS alone doesn't stop a cross-site "simple" POST from *executing*. So a middleware also refuses any non-GET/HEAD/OPTIONS request whose `Origin` header is present but not allow-listed: 403 `ORIGIN_NOT_ALLOWED`.
- **Wildcards:** `*` and invalid entries in `FORGEGUARD_ALLOWED_ORIGINS` are ignored, with a warning.

## S4 — Input limits

- `issueText` must be a non-empty string of at most **12,000 characters** (JS string length). Otherwise the answer is 400:
  - `ISSUE_TEXT_TOO_LONG`, with `maxLength` and `length`
  - or `ISSUE_TEXT_REQUIRED`
- This is checked at the API boundary before a mission row exists. The limit is well above a detailed issue report and well below prompt-size trouble; the text is fanned out to 9 Bob prompts.
- The JSON body is capped at **100 kB**. That leaves room for 12,000 characters even when every character is escaped. Larger bodies get 413 `PAYLOAD_TOO_LARGE`.
- Malformed JSON gets 400 `INVALID_JSON`. These answers replace Express's default HTML errors.

## S6 — No dynamic SQL keys

`updateMissionStatus(id, status, extra)` used to interpolate `Object.keys(extra)` into SQL. Now:

- Keys must be in an explicit allow-list: `repo_summary`, `change_plan`, `validation_result`, `release_report`, `rollback_ref`, `error_message`.
- Any other key throws **before any SQL runs**.
- The column names in the statement come from the allow-list constant, never from the caller's strings.
- Values are always bound parameters.

## Evidence and logging rules

| Event | Where it is recorded |
|---|---|
| Mission-creation rejected (bad repo, oversized text, bad origin) | Server log line with the code only. No mission exists yet, so there's no evidence row. |
| Start preflight rejected (`REPO_NOT_ALLOWED`, `REPO_NOT_GIT`, `BOB_UNAVAILABLE`) | `error` evidence, `phase_name = 'preflight'`, `{ code, error, at }`; the mission is marked `failed` |
| WebSocket origin rejected | Server log line, without the origin value |
| Rollback, lock and anchor failures | `error` evidence with a code (see `ROLLBACK_DESIGN.md`) |

All evidence goes through `recordEvidence`, which redacts values of secret-named environment variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`). HTTP error bodies are generic: no stack traces, no git stderr, no filesystem paths.

## Accepted limitations

Section numbers in this document follow the Milestone 5 brief. In the audit (`CLAUDE_AUDIT.md` §5), the input limit was **S7** and **S4** was prompt injection.

- **Audit S4, prompt injection:** issue text still reaches a write-enabled agent during the implementation phase (Bob `agent` mode). Mitigations: the repository allow-list confines the agent to approved directories; `--disable-tool-groups edit,execute,mode,artifact` is enforced for all read-only phases (1, 2, 3, 6); the rollback anchor enables full recovery; and the deterministic release verdict prevents the agent's narrative from overriding validation results. The user-level Bob settings (`outsideWorkspaceAllowed`, etc.) are the user's responsibility.
- **No authentication:** any local process on the loopback interface can use the API. Binding to another interface via `FORGEGUARD_HOST` exposes it. This is a design decision for a local development tool; the loopback bind is the access control.

## Final security assessment (2026-09-27)

**Classification: SECURITY READY WITH ACCEPTED LIMITATIONS**

A comprehensive penetration test (103 active probes) and full code review found no CRITICAL or HIGH vulnerabilities. All security controls listed above are verified by both code inspection and active testing. The full regression suite (189 tests) passes. See `docs/FINAL_SECURITY_AUDIT.md` for the complete findings table and penetration test evidence.
