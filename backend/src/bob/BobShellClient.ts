/**
 * BobShellClient.ts — Primary Bob provider using Bob Shell headless mode.
 *
 * Verified against the locally installed Bob Shell 2.0.5 (`bob run --help`):
 *
 *   bob run --mode <ask|plan|agent> -w <workspace> --max-turns <n>
 *           -f stream-json [--disable-tool-groups <groups>] -- <prompt>
 *
 * Launch safety:
 *   - The executable is resolved by resolveBobLaunch(): normally the current Node
 *     binary plus the bobshell `dist/bob.js` entry point (never the .cmd wrapper).
 *   - Arguments are passed as an array with `shell: false`; the prompt (which
 *     contains untrusted issue text) is a single argv element after `--`, so it
 *     can never be parsed as a shell command or as a Bob option.
 *
 * Success is strict: exit code 0 AND a `result` event with status "success"
 * AND no `error` events. Anything else is a failure with a classified errorKind.
 *
 * Authentication: Bob Shell reads BOBSHELL_API_KEY from the environment (or its
 * own stored login). The key is never placed in arguments or evidence.
 */

import { spawn } from 'child_process';
import type {
  BobClient,
  BobInvocation,
  BobMode,
  BobProviderStatus,
  BobTaskOptions,
  BobTaskResult,
} from './BobClient';
import { resolveBobLaunch, type BobLaunch } from './resolveBob';
import { BobStreamJsonParser } from './StreamParser';
import { redactSecrets } from './redact';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TURNS = 30;
const PROBE_TIMEOUT_MS = 20_000;
const MIN_NODE_MAJOR = 22; // bobshell 2.0.5 package.json: "engines": { "node": ">=22" }

/** Tool groups disabled for read-only tasks (group names from Bob's built-in modes). */
export const READ_ONLY_DISABLED_TOOL_GROUPS = 'edit,execute,mode,artifact';

/** Flags ForgeGuard relies on; checked against `bob run --help`. */
const REQUIRED_RUN_FLAGS = ['--mode', '--workspace', '--format', '--max-turns', '--disable-tool-groups', 'stream-json'];

export interface BuiltArgs {
  /** Bob arguments (after any prefix such as the entry point). */
  args: string[];
  /** Same arguments with the prompt replaced by a placeholder, for evidence. */
  displayArgs: string[];
}

/** Build the `bob run` argument vector. Pure — exported for tests. */
export function buildRunArgs(options: {
  prompt: string;
  workspace: string;
  mode: BobMode;
  maxTurns: number;
  allowFileWrites: boolean;
}): BuiltArgs {
  const head = [
    'run',
    '--mode', options.mode,
    '-w', options.workspace,
    '--max-turns', String(options.maxTurns),
    '-f', 'stream-json',
  ];
  if (!options.allowFileWrites) {
    head.push('--disable-tool-groups', READ_ONLY_DISABLED_TOOL_GROUPS);
  }
  // `--` ends option parsing so a prompt beginning with "-" is still a prompt.
  head.push('--');
  return {
    args: [...head, options.prompt],
    displayArgs: [...head, `<prompt: ${options.prompt.length} chars, stored as prompt evidence>`],
  };
}

interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut: boolean;
}

/** Run a process with an argv array and no shell. */
function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; onStdout?: (chunk: string) => void },
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (o: ProcessOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(o);
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ exitCode: null, stdout: '', stderr: '', spawnError: (e as Error).message, timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => {
      out.push(d);
      opts.onStdout?.(d);
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (d: string) => err.push(d));

    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ exitCode: null, stdout: out.join(''), stderr: err.join(''), spawnError: e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ exitCode: code, stdout: out.join(''), stderr: err.join(''), timedOut });
    });
  });
}

export class BobShellClient implements BobClient {
  readonly provider = 'shell' as const;

  private get timeoutMs(): number {
    const v = parseInt(process.env['BOB_TIMEOUT_MS'] ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
  }

  private get maxTurns(): number {
    const v = parseInt(process.env['BOB_MAX_TURNS'] ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_TURNS;
  }

  async runTask(options: BobTaskOptions): Promise<BobTaskResult> {
    const start = Date.now();
    const startedAt = new Date(start).toISOString();
    const taskId = options.taskId ?? `shell-${start}`;
    const mode: BobMode = options.mode ?? 'plan';
    const built = buildRunArgs({
      prompt: options.prompt,
      workspace: options.workspace,
      mode,
      maxTurns: options.maxTurns ?? this.maxTurns,
      allowFileWrites: options.allowFileWrites === true,
    });

    const resolution = resolveBobLaunch();
    const invocation: BobInvocation = {
      provider: 'shell',
      command: resolution.ok ? resolution.launch.command : null,
      entryPoint: resolution.ok ? resolution.launch.entryPoint : null,
      args: resolution.ok ? [...resolution.launch.prefixArgs, ...built.displayArgs] : built.displayArgs,
      workspace: options.workspace,
      mode,
    };

    const fail = (partial: Partial<BobTaskResult> & Pick<BobTaskResult, 'error' | 'errorKind'>): BobTaskResult => {
      const end = Date.now();
      return {
        taskId,
        success: false,
        output: '',
        durationMs: end - start,
        startedAt,
        completedAt: new Date(end).toISOString(),
        invocation,
        ...partial,
      };
    };

    if (!resolution.ok) {
      return fail({ errorKind: 'unavailable', error: `BOB_UNAVAILABLE: ${resolution.error}` });
    }

    const timeout = options.timeoutMs ?? this.timeoutMs;
    const parser = new BobStreamJsonParser(
      options.onChunk ? (delta) => options.onChunk!(redactSecrets(delta)) : undefined,
    );
    const outcome = await runProcess(resolution.launch.command, [...resolution.launch.prefixArgs, ...built.args], {
      cwd: options.workspace,
      timeoutMs: timeout,
      onStdout: (d) => parser.feed(d),
    });
    const summary = parser.finish();
    const end = Date.now();

    const stdout = redactSecrets(outcome.stdout);
    const stderr = redactSecrets(outcome.stderr);
    const output = redactSecrets(summary.assistantText);

    const base: BobTaskResult = {
      taskId,
      success: false,
      output,
      durationMs: end - start,
      startedAt,
      completedAt: new Date(end).toISOString(),
      stdout,
      stderr,
      invocation,
    };
    if (outcome.exitCode != null) base.exitCode = outcome.exitCode;
    if (summary.bobTaskId) base.bobTaskId = summary.bobTaskId;

    if (outcome.spawnError) {
      return { ...base, errorKind: 'spawn_failed', error: `Failed to start Bob Shell: ${outcome.spawnError}` };
    }
    if (outcome.timedOut) {
      return { ...base, errorKind: 'timeout', error: `Bob Shell task timed out after ${timeout}ms` };
    }
    if (summary.errors.length > 0) {
      return { ...base, errorKind: 'bob_error', error: `Bob reported an error: ${redactSecrets(summary.errors.join(' | '))}` };
    }
    if (outcome.exitCode !== 0) {
      const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      return {
        ...base,
        errorKind: 'nonzero_exit',
        error: `Bob Shell exited with code ${outcome.exitCode}${detail ? `: ${detail}` : ''}`,
      };
    }
    if (summary.resultStatus !== 'success') {
      return {
        ...base,
        errorKind: 'no_result',
        error:
          summary.resultStatus === null
            ? 'Bob Shell exited without emitting a result event'
            : `Bob Shell result status was "${summary.resultStatus}"`,
      };
    }
    return { ...base, success: true };
  }

  async checkAvailability(): Promise<BobProviderStatus> {
    const note = 'Availability does not verify authentication or remaining Bob credits; only a real task can.';
    const unavailable = (error: string, launch?: BobLaunch, extra: Partial<BobProviderStatus> = {}): BobProviderStatus => ({
      provider: 'shell',
      available: false,
      code: 'BOB_UNAVAILABLE',
      error,
      ...(launch ? { command: launch.command, entryPoint: launch.entryPoint, resolvedVia: launch.source } : {}),
      note,
      ...extra,
    });

    const resolution = resolveBobLaunch();
    if (!resolution.ok) return unavailable(resolution.error);
    const launch = resolution.launch;

    if (launch.entryPoint) {
      const major = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
      if (major < MIN_NODE_MAJOR) {
        return unavailable(`Bob Shell requires Node >= ${MIN_NODE_MAJOR}; ForgeGuard is running on Node ${process.versions.node}.`, launch);
      }
    }

    const version = await runProcess(launch.command, [...launch.prefixArgs, '--version'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (version.spawnError || version.timedOut || version.exitCode !== 0) {
      const why = version.spawnError ?? (version.timedOut ? 'timed out' : `exit code ${version.exitCode}`);
      return unavailable(`"bob --version" failed (${why}): ${redactSecrets((version.stderr || version.stdout).trim()).slice(0, 300)}`, launch);
    }
    const versionText = redactSecrets(version.stdout.trim().split('\n')[0] ?? '');

    const help = await runProcess(launch.command, [...launch.prefixArgs, 'run', '--help'], { timeoutMs: PROBE_TIMEOUT_MS });
    const helpText = `${help.stdout}\n${help.stderr}`;
    const missingFlags = REQUIRED_RUN_FLAGS.filter((f) => !helpText.includes(f));
    const runSyntax = { supported: help.exitCode === 0 && missingFlags.length === 0, missingFlags };
    if (!runSyntax.supported) {
      return unavailable(
        `Installed Bob Shell (${versionText}) does not support the required "bob run" syntax` +
          (missingFlags.length ? ` (missing: ${missingFlags.join(', ')})` : ''),
        launch,
        { version: versionText, runSyntax },
      );
    }

    return {
      provider: 'shell',
      available: true,
      version: versionText,
      command: launch.command,
      entryPoint: launch.entryPoint,
      resolvedVia: launch.source,
      runSyntax,
      note,
    };
  }
}
