# Validation Policy

Validation is the evidence behind every release claim. The verdict logic built on top of it is in [RELEASE_VERDICT.md](RELEASE_VERDICT.md).

## Commands

These four commands are fixed constants (`REQUIRED_VALIDATION_COMMANDS`). They never contain user input:

```
npm run lint
npm test
npm run typecheck
npm run build
```

They run twice, with the same list both times:

| Run | When | `run_kind` | `phase_id` |
|---|---|---|---|
| Baseline | Start of the mission (inside Phase 1), before any Bob analysis, holding the repository lock | `baseline` | that run's `repo_understanding` phase |
| Post | Phase 5, after implementation, still holding the lock taken for implementation | `post` | that run's `validation` phase |

After the baseline, ForgeGuard records a snapshot of the working tree. Implementation is refused if the tree has changed by the time the rollback anchor is created (`REPO_CHANGED_SINCE_BASELINE`), because the baseline would then no longer describe the code Bob changes.

## Execution

- **Spawning:** the command is split on spaces into an argv array.
  - On Windows it runs through a shell, so `npm` resolves to `npm.cmd`. That's safe because the strings are constants.
  - On POSIX it runs without a shell, as its own process group.
- **Output:** stdout and stderr are captured verbatim, then secrets are redacted.
- **Stored per run:** `exit_code`, `passed`, `timed_out`, `stdout`, `stderr`, `started_at`, `completed_at`, `duration_ms`.

## Timeout

- **Setting:** `FORGEGUARD_VALIDATION_TIMEOUT_MS`, per command. The default is **180000 ms (3 minutes)**, which is generous against the demo-app's 4–8 s per command. An invalid value falls back to the default, with a warning.
- **Killing:** when the timeout expires, the **whole process tree** is killed.
  - **Windows:** `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F`. `child.kill()` would only stop `cmd.exe` and leave `npm` and `node` running.
  - **POSIX:** `SIGTERM` to the process group, then `SIGKILL` after 2 s.
- **Bounded wait:** if the output pipes still haven't closed 5 s after the kill, ForgeGuard stops waiting and detaches the streams, so the pipeline can't hang.
- **Unambiguous result:** `timed_out = 1`, `exit_code = NULL`, `passed = 0`. A real exit code is never NULL.
- **Partial output:** whatever stdout and stderr arrived before the kill is persisted.
- **Evidence:** an `error` row with `event: validation_timeout`, `code: VALIDATION_TIMEOUT`, the command, `kind`, `timeoutMs`, `startedAt`, `completedAt`, `durationMs`, `stdout` and `stderr`. It goes under phase `validation` or `baseline_validation`.

How a timeout affects the verdict:

| Where it times out | Classification | Verdict effect |
|---|---|---|
| Post-implementation run | `timed_out` | **blocked**. Phase 5 fails with `Release blocked: "<cmd>" timed out after implementation…` |
| Baseline run | Treated as *no baseline evidence* | If post passes: `pass_without_baseline`, so conditional. If post fails: `unclassified_failure`, so blocked. |

A timed-out row that claims an exit code or `passed = 1` is malformed, and malformed data means no verdict.

## Verified behaviour (real processes, Windows)

- A script that prints partial output and then hangs, run through `npm run typecheck` → `cmd.exe` → `node`, is killed after the timeout. The partial stdout and stderr are kept, and the grandchild `node` PID is confirmed dead.
- With the tree kill disabled (a mutation check), those `cmd.exe` and `node` processes stayed alive. They were found and stopped afterwards.
- In a full pipeline run with the real executor and a 4 s timeout, a post-implementation hang fails Phase 5, the verdict is `blocked`, Bob's release report is never requested, and the hung process is dead.

## Evidence rules

- Every claim about validation traces to a `validation_runs` row with the real command output.
- Nothing is synthesised. When a command can't be spawned, it's recorded with exit code 1 and the spawn error in `stderr`.
- Test doubles (a fake executor, fake Bob) exist only under `backend/tests/`.
