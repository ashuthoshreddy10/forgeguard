import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { resolveBobLaunch } from '../src/bob/resolveBob';

const NODE = 'C:\\node\\node.exe';

function fsWith(files: string[]): (p: string) => boolean {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
}
const noRealpath = (p: string): string => p;

describe('resolveBobLaunch (Windows)', () => {
  const npmDir = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
  const entry = `${npmDir}\\node_modules\\bobshell\\dist\\bob.js`;

  it('resolves the npm bob.cmd wrapper to node + bobshell entry point', () => {
    const r = resolveBobLaunch({
      env: { PATH: `C:\\Windows;${npmDir}` },
      platform: 'win32',
      nodeExecutable: NODE,
      fileExists: fsWith([`${npmDir}\\bob.cmd`, `${npmDir}\\bob`, entry]),
      realpath: noRealpath,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.launch.command).toBe(NODE);
    expect(r.launch.prefixArgs).toEqual([entry]);
    expect(r.launch.entryPoint).toBe(entry);
  });

  it('refuses to launch a .cmd wrapper whose entry point cannot be found', () => {
    const r = resolveBobLaunch({
      env: { PATH: npmDir },
      platform: 'win32',
      nodeExecutable: NODE,
      fileExists: fsWith([`${npmDir}\\bob.cmd`]),
      realpath: noRealpath,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/refusing to launch a shell wrapper/);
  });

  it('honours BOB_CLI_PATH pointing at a .js entry point', () => {
    const r = resolveBobLaunch({
      env: { BOB_CLI_PATH: 'D:\\tools\\bob.js', PATH: '' },
      platform: 'win32',
      nodeExecutable: NODE,
      fileExists: fsWith(['D:\\tools\\bob.js']),
      realpath: noRealpath,
    });
    expect(r.ok && r.launch.command === NODE && r.launch.prefixArgs[0] === 'D:\\tools\\bob.js').toBe(true);
  });

  it('reports a missing BOB_CLI_PATH', () => {
    const r = resolveBobLaunch({ env: { BOB_CLI_PATH: 'D:\\nope\\bob.js' }, platform: 'win32', fileExists: () => false });
    expect(r.ok).toBe(false);
  });

  it('reports Bob not found when nothing is on PATH', () => {
    const r = resolveBobLaunch({ env: { PATH: 'C:\\Windows' }, platform: 'win32', fileExists: () => false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/not found/);
  });
});

describe('resolveBobLaunch (POSIX)', () => {
  it('follows a symlinked bin to bob.js and runs it with node', () => {
    const r = resolveBobLaunch({
      env: { PATH: '/usr/local/bin' },
      platform: 'linux',
      nodeExecutable: '/usr/bin/node',
      fileExists: fsWith(['/usr/local/bin/bob', '/usr/local/lib/node_modules/bobshell/dist/bob.js']),
      realpath: () => '/usr/local/lib/node_modules/bobshell/dist/bob.js',
    });
    expect(r.ok && r.launch.entryPoint).toBe('/usr/local/lib/node_modules/bobshell/dist/bob.js');
  });
});

// Environment check against the real local installation (no Bob task is run).
const localEntry = process.env['APPDATA']
  ? path.join(process.env['APPDATA'], 'npm', 'node_modules', 'bobshell', 'dist', 'bob.js')
  : '';
describe.skipIf(!localEntry || !fs.existsSync(localEntry))('local Bob installation', () => {
  it('resolves to the installed bobshell entry point, launched via Node', () => {
    const r = resolveBobLaunch({ env: { ...process.env, BOB_CLI_PATH: 'bob' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.launch.command).toBe(process.execPath);
    expect(r.launch.entryPoint?.toLowerCase()).toBe(localEntry.toLowerCase());
  });
});
