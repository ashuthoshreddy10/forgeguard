/**
 * FakeBobClient — test-only stand-in for Bob. Never reachable from the application.
 */
import type { BobClient, BobProviderStatus, BobTaskOptions, BobTaskResult } from '../../src/bob/BobClient';

export type Behavior = 'ok' | 'fail' | 'no-json' | 'leak';
export const json = (o: unknown): string => `--- FORGEGUARD:JSON ---\n${JSON.stringify(o)}\n--- END ---`;

export const GOOD_OUTPUT: Record<string, string> = {
  repo_understander: json({ summary: 'demo', primaryFiles: ['src/pricing.ts'] }),
  plan_synthesizer: json({ summary: 'Clamp rate', steps: [{ order: 1, file: 'src/pricing.ts', description: 'clamp' }] }),
  implementer: 'Implemented all steps.',
  release_engineer: json({ releaseReadiness: 'ready', summary: 'All validation passed.' }),
};

/** Identify the task from the prompt's role line (prompts.ts). */
export function typeTag(prompt: string): string {
  const map: Array<[RegExp, string]> = [
    [/RepoUnderstander/, 'repo_understander'], [/CodeImpactAnalyst/, 'code_impact_analyst'],
    [/TestEngineer/, 'test_engineer'], [/SecurityAnalyst/, 'security_analyst'],
    [/APICompatAnalyst/, 'api_compat_analyst'], [/DocAnalyst/, 'doc_analyst'],
    [/PlanSynthesizer/, 'plan_synthesizer'], [/Implementer/, 'implementer'], [/ReleaseEngineer/, 'release_engineer'],
  ];
  return map.find(([re]) => re.test(prompt))?.[1] ?? 'unknown';
}

export interface FakeBobOptions {
  behavior?: Record<string, Behavior>;
  available?: boolean;
  overrides?: Record<string, string>;
  /** Runs when the implementer task is invoked (e.g. to edit files in the workspace). */
  onImplement?: (workspace: string) => void | Promise<void>;
  secret?: string;
}

export class FakeBobClient implements BobClient {
  readonly provider = 'shell' as const;
  calls: string[] = [];
  constructor(private readonly o: FakeBobOptions = {}) {}

  async checkAvailability(): Promise<BobProviderStatus> {
    return this.o.available === false
      ? { provider: 'shell', available: false, code: 'BOB_UNAVAILABLE', error: 'Bob Shell CLI not found on PATH.' }
      : { provider: 'shell', available: true, version: 'fake' };
  }

  async runTask(t: BobTaskOptions): Promise<BobTaskResult> {
    const type = typeTag(t.prompt);
    this.calls.push(type);
    const b = this.o.behavior?.[type] ?? 'ok';
    const base = { taskId: t.taskId ?? 'x', durationMs: 7, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    if (b === 'fail') {
      return { ...base, success: false, output: '', exitCode: 1, errorKind: 'bob_error',
        stdout: '{"type":"error"}', stderr: 'Budget exceeded', error: 'Bob reported an error: Budget exceeded' };
    }
    if (type === 'implementer' && this.o.onImplement) await this.o.onImplement(t.workspace);
    if (b === 'leak') {
      const s = this.o.secret ?? '';
      return { ...base, success: true, exitCode: 0, output: `${GOOD_OUTPUT[type] ?? json({ f: 1 })} key=${s}`, stdout: `key=${s}`, stderr: '' };
    }
    const output = b === 'no-json' ? 'I analysed it but forgot the block.' : this.o.overrides?.[type] ?? GOOD_OUTPUT[type] ?? json({ findings: ['x'] });
    return { ...base, success: true, exitCode: 0, output, stdout: output, stderr: '', bobTaskId: `bob-${type}` };
  }
}
