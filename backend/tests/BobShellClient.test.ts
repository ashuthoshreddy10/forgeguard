import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BobShellClient, buildRunArgs, READ_ONLY_DISABLED_TOOL_GROUPS } from '../src/bob/BobShellClient';
import { redactSecrets, REDACTED } from '../src/bob/redact';

const FAKE_BOB = path.join(__dirname, 'fixtures', 'fake-bob.mjs');
const SECRET = 'sk-test-SUPERSECRET-0123456789';

let tmp: string;
let argvFile: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-bob-'));
  argvFile = path.join(tmp, 'argv.json');
  process.env['BOB_CLI_PATH'] = FAKE_BOB;
  process.env['FAKE_BOB_ARGV_FILE'] = argvFile;
  process.env['BOBSHELL_API_KEY'] = SECRET;
  delete process.env['FAKE_BOB_BEHAVIOR'];
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('buildRunArgs', () => {
  it('builds the verified `bob run` shape with each value as its own element', () => {
    const { args, displayArgs } = buildRunArgs({
      prompt: 'Analyse this', workspace: 'C:\\repo', mode: 'ask', maxTurns: 12, allowFileWrites: false,
    });
    expect(args).toEqual([
      'run', '--mode', 'ask', '-w', 'C:\\repo', '--max-turns', '12', '-f', 'stream-json',
      '--disable-tool-groups', READ_ONLY_DISABLED_TOOL_GROUPS, '--', 'Analyse this',
    ]);
    expect(args).not.toContain('--chat-mode');
    expect(displayArgs[displayArgs.length - 1]).toMatch(/^<prompt: 12 chars/);
  });

  it('leaves write-capable tool groups enabled only when allowFileWrites is true', () => {
    const { args } = buildRunArgs({ prompt: 'p', workspace: '.', mode: 'agent', maxTurns: 1, allowFileWrites: true });
    expect(args).not.toContain('--disable-tool-groups');
  });
});

describe('BobShellClient.runTask (fake bob entry point, shell: false)', () => {
  it('passes a prompt full of shell metacharacters through as ONE literal argument', async () => {
    const evil = `fix bug"; echo PWNED > pwned.txt & echo X > injected.txt | whoami $(id) \`id\` %PATH% ^& || type nul > injected2.txt`;
    const r = await new BobShellClient().runTask({ prompt: evil, workspace: tmp, mode: 'ask' });
    expect(r.success).toBe(true);
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[];
    expect(argv[argv.length - 1]).toBe(evil);
    expect(argv[argv.length - 2]).toBe('--');
    expect(argv.slice(0, 5)).toEqual(['run', '--mode', 'ask', '-w', tmp]);
    for (const f of ['pwned.txt', 'injected.txt', 'injected2.txt']) expect(fs.existsSync(path.join(tmp, f))).toBe(false);
  });

  it('treats a prompt that starts with "-" as a prompt, not an option', async () => {
    await new BobShellClient().runTask({ prompt: '--yolo --mode agent', workspace: tmp, mode: 'ask' });
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[];
    expect(argv.indexOf('--')).toBe(argv.length - 2);
    expect(argv.filter((a) => a === '--mode')).toHaveLength(1);
  });

  it('parses stream-json: assistant text (not reasoning), Bob task id, invocation record', async () => {
    const r = await new BobShellClient().runTask({ prompt: 'p', workspace: tmp, mode: 'plan' });
    expect(r.success).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.bobTaskId).toBe('bob-task-123');
    expect(r.output).toContain('--- FORGEGUARD:JSON ---\n{"ok":true}');
    expect(r.output).not.toContain('thinking...');
    expect(r.invocation?.command).toBe(process.execPath);
    expect(r.invocation?.entryPoint).toBe(FAKE_BOB);
    expect(r.invocation?.args.some((a) => a.startsWith('<prompt:'))).toBe(true);
    expect(r.startedAt && r.completedAt).toBeTruthy();
  });

  it('classifies a Bob error event + non-zero exit as bob_error', async () => {
    process.env['FAKE_BOB_BEHAVIOR'] = 'error';
    const r = await new BobShellClient().runTask({ prompt: 'p', workspace: tmp });
    expect(r.success).toBe(false);
    expect(r.errorKind).toBe('bob_error');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('task limit');
  });

  it('fails when Bob emits an error event even with exit code 0', async () => {
    process.env['FAKE_BOB_BEHAVIOR'] = 'error-exit0';
    const r = await new BobShellClient().runTask({ prompt: 'p', workspace: tmp });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Budget exceeded/);
  });

  it('classifies a non-zero exit without events as nonzero_exit', async () => {
    process.env['FAKE_BOB_BEHAVIOR'] = 'nonzero';
    const r = await new BobShellClient().runTask({ prompt: 'p', workspace: tmp });
    expect(r).toMatchObject({ success: false, errorKind: 'nonzero_exit', exitCode: 3 });
    expect(r.error).toMatch(/boom/);
  });

  it('does not treat exit 0 without a result event as success', async () => {
    process.env['FAKE_BOB_BEHAVIOR'] = 'noresult';
    const r = await new BobShellClient().runTask({ prompt: 'p', workspace: tmp });
    expect(r).toMatchObject({ success: false, errorKind: 'no_result' });
  });

  it('kills and classifies a task that exceeds its timeout', async () => {
    process.env['FAKE_BOB_BEHAVIOR'] = 'hang';
    const r = await new BobShellClient().runTask({ prompt: 'p', workspace: tmp, timeoutMs: 1500 });
    expect(r).toMatchObject({ success: false, errorKind: 'timeout' });
  }, 15_000);

  it('returns BOB_UNAVAILABLE without spawning when the CLI cannot be resolved', async () => {
    process.env['BOB_CLI_PATH'] = path.join(tmp, 'does-not-exist.js');
    const r = await new BobShellClient().runTask({ prompt: 'p', workspace: tmp });
    expect(r).toMatchObject({ success: false, errorKind: 'unavailable' });
    expect(r.error).toMatch(/^BOB_UNAVAILABLE/);
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  it('redacts secret environment values from output, stdout and stderr', async () => {
    process.env['FAKE_BOB_BEHAVIOR'] = 'leak';
    const r = await new BobShellClient().runTask({ prompt: 'p', workspace: tmp });
    const all = `${r.output}\n${r.stdout}\n${r.stderr}\n${JSON.stringify(r.invocation)}`;
    expect(all).not.toContain(SECRET);
    expect(all).toContain(REDACTED);
  });
});

describe('BobShellClient.checkAvailability', () => {
  it('reports version, resolved entry point, and run syntax support', async () => {
    const s = await new BobShellClient().checkAvailability();
    expect(s).toMatchObject({ available: true, version: '9.9.9-fake', entryPoint: FAKE_BOB });
    expect(s.runSyntax).toEqual({ supported: true, missingFlags: [] });
  });

  it('is BOB_UNAVAILABLE when the installed CLI lacks the `bob run` flags', async () => {
    process.env['FAKE_BOB_HELP'] = 'Usage: bob -p <prompt> --chat-mode <mode>';
    const s = await new BobShellClient().checkAvailability();
    expect(s.available).toBe(false);
    expect(s.code).toBe('BOB_UNAVAILABLE');
    expect(s.runSyntax?.missingFlags).toContain('--workspace');
  });

  it('is BOB_UNAVAILABLE when the CLI is missing', async () => {
    process.env['BOB_CLI_PATH'] = path.join(tmp, 'missing', 'bob.js');
    const s = await new BobShellClient().checkAvailability();
    expect(s).toMatchObject({ available: false, code: 'BOB_UNAVAILABLE' });
  });
});

describe('redactSecrets', () => {
  it('only redacts values of secret-named env vars', () => {
    const env = { BOBSHELL_API_KEY: 'abcdef123456', MY_TOKEN: 'tok-999999', HOME: '/home/user' };
    expect(redactSecrets('k=abcdef123456 t=tok-999999 h=/home/user', env)).toBe(
      `k=${REDACTED} t=${REDACTED} h=/home/user`,
    );
  });
});
