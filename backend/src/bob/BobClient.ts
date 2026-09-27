/**
 * BobClient.ts — Provider-agnostic interface for all Bob 2.0 interactions.
 *
 * The rest of ForgeGuard MUST interact with Bob only through this interface.
 * Never import BobShellClient or BobApiClient directly from pipeline code.
 */

/**
 * Bob execution modes. These are the built-in mode slugs accepted by
 * `bob run --mode <slug>` in Bob Shell 2.0.5 (ask, plan, agent).
 */
export type BobMode = 'plan' | 'agent' | 'ask';

/** Bob provider implementations available. */
export type BobProvider = 'shell' | 'api';

/** Options for a single Bob task execution. */
export interface BobTaskOptions {
  /** Natural-language prompt to send to Bob. */
  prompt: string;

  /** Working directory Bob should operate in. */
  workspace: string;

  /** Bob mode to use for this task. Defaults to 'plan'. */
  mode?: BobMode;

  /** Maximum time to wait for the task to complete, in milliseconds. */
  timeoutMs?: number;

  /** Maximum number of turns Bob may take. */
  maxTurns?: number;

  /**
   * If false (default), ForgeGuard disables Bob's write-capable tool groups
   * (`--disable-tool-groups edit,execute,mode,artifact`) so the task is read-only.
   * If true, the mode's full tool set is left enabled. Whether individual edits
   * are auto-approved is governed by the user's Bob approval settings.
   */
  allowFileWrites?: boolean;

  /** Optional external task ID for correlation. */
  taskId?: string;

  /**
   * Callback invoked with each piece of assistant text Bob actually streams
   * (parsed from real stream-json events — never synthesised).
   */
  onChunk?: (chunk: string) => void;
}

/** Why a Bob task failed. */
export type BobErrorKind =
  | 'unavailable'      // CLI/entry point could not be resolved
  | 'spawn_failed'     // process could not be started
  | 'timeout'          // killed after timeoutMs
  | 'nonzero_exit'     // process exited with a non-zero code
  | 'bob_error'        // Bob emitted an error event (max turns, budget, auth...)
  | 'no_result'        // exited 0 but never emitted a successful result event
  | 'not_implemented'; // provider is a stub

/** Diagnostic record of how Bob was invoked. Secrets are redacted. */
export interface BobInvocation {
  provider: BobProvider;
  command: string | null;
  entryPoint: string | null;
  /** Arguments as passed to the process; the prompt is replaced by a placeholder. */
  args: string[];
  workspace: string;
  mode: BobMode;
}

/** Result of a completed Bob task. */
export interface BobTaskResult {
  /** The unique ID assigned to this task by Bob or by ForgeGuard. */
  taskId: string;

  /** Whether the task completed successfully. */
  success: boolean;

  /** Full response text from Bob. */
  output: string;

  /** Elapsed time in milliseconds. */
  durationMs: number;

  /** Exit code (for shell provider; undefined for API provider). */
  exitCode?: number;

  /** Error message if the task failed. */
  error?: string;

  /** Failure classification (set whenever success is false). */
  errorKind?: BobErrorKind;

  /** Bob's own task ID, if Bob reported one. */
  bobTaskId?: string;

  /** Verbatim (redacted) process output streams. */
  stdout?: string;
  stderr?: string;

  startedAt?: string;
  completedAt?: string;

  /** How the task was launched, for the evidence record. */
  invocation?: BobInvocation;
}

/** Status of the Bob provider / CLI availability. */
export interface BobProviderStatus {
  provider: BobProvider;
  available: boolean;
  /** Machine-readable code when unavailable. */
  code?: 'BOB_UNAVAILABLE';
  version?: string;
  error?: string;
  /** Executable that would be spawned. */
  command?: string;
  /** Resolved bobshell entry point (when launched through Node). */
  entryPoint?: string | null;
  /** How the launch was resolved. */
  resolvedVia?: string;
  /** Whether `bob run --help` advertises the flags ForgeGuard relies on. */
  runSyntax?: { supported: boolean; missingFlags: string[] };
  /**
   * Honest note: availability does NOT prove authentication or remaining credits.
   * Those can only be observed by running a real task.
   */
  note?: string;
}

/**
 * BobClient — the single interface all ForgeGuard pipeline code uses to interact with Bob.
 *
 * Implementations:
 *  - BobShellClient  (primary, uses `bob -p` non-interactive mode)
 *  - BobApiClient    (secondary/fallback, uses Bob REST API)
 */
export interface BobClient {
  /** The provider backing this client. */
  readonly provider: BobProvider;

  /**
   * Execute a Bob task and return the result.
   * Streams output via options.onChunk if provided.
   */
  runTask(options: BobTaskOptions): Promise<BobTaskResult>;

  /**
   * Check whether the underlying Bob provider is available and authenticated.
   * Must NOT perform destructive operations.
   */
  checkAvailability(): Promise<BobProviderStatus>;
}

/**
 * Factory: create a BobClient for the given provider.
 * Reads provider selection from environment if not specified.
 */
export function createBobClient(provider?: BobProvider): BobClient {
  const envProvider = process.env['BOB_PROVIDER'];
  const resolved: BobProvider = provider ?? (envProvider === 'api' ? 'api' : 'shell');

  if (resolved === 'api') {
    // Lazy import to avoid loading API client when shell is used
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BobApiClient } = require('./BobApiClient') as typeof import('./BobApiClient');
    return new BobApiClient();
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BobShellClient } = require('./BobShellClient') as typeof import('./BobShellClient');
  return new BobShellClient();
}
