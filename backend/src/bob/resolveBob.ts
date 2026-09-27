/**
 * resolveBob.ts — Locate the Bob Shell CLI and decide how to launch it safely.
 *
 * Bob Shell is distributed as the npm package `bobshell`, whose bin is the
 * Node ES module `dist/bob.js`. npm installs `bob` / `bob.cmd` / `bob.ps1`
 * wrapper scripts that simply run `node <prefix>/node_modules/bobshell/dist/bob.js`.
 *
 * On Windows a `.cmd` wrapper cannot be spawned without a shell (Node refuses with
 * EINVAL), and running it through cmd.exe would let prompt text be interpreted as
 * shell syntax. ForgeGuard therefore never launches the wrapper: it resolves the
 * underlying `bob.js` entry point and runs it with the current Node executable,
 * passing every argument as a separate array element with `shell: false`.
 */

import fs from 'fs';
import path from 'path';

/** Relative location of the Bob entry point inside an npm global prefix. */
const ENTRY_FROM_PREFIX = path.join('node_modules', 'bobshell', 'dist', 'bob.js');

export interface BobLaunch {
  /** Executable to spawn (Node, or a native Bob binary). */
  command: string;
  /** Arguments that precede Bob's own arguments (e.g. the entry-point path). */
  prefixArgs: string[];
  /** Resolved `bob.js` entry point, when Bob is launched through Node. */
  entryPoint: string | null;
  /** How the launch was resolved, for diagnostics. */
  source: string;
}

export type BobResolution =
  | { ok: true; launch: BobLaunch }
  | { ok: false; error: string };

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  fileExists?: (p: string) => boolean;
  realpath?: (p: string) => string;
}

const SCRIPT_ENTRY = /\.(c|m)?js$/i;
const WINDOWS_WRAPPER = /\.(cmd|bat|ps1)$/i;

export function resolveBobLaunch(options: ResolveOptions = {}): BobResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const node = options.nodeExecutable ?? process.execPath;
  const exists = options.fileExists ?? defaultFileExists;
  const realpath = options.realpath ?? ((p: string) => fs.realpathSync(p));
  const pathMod = platform === 'win32' ? path.win32 : path.posix;

  const viaNode = (entryPoint: string, source: string): BobResolution => ({
    ok: true,
    launch: { command: node, prefixArgs: [entryPoint], entryPoint, source },
  });

  /** Given a wrapper/binary location, find the launch for it. */
  const fromFile = (file: string, source: string): BobResolution | null => {
    if (SCRIPT_ENTRY.test(file)) {
      return exists(file) ? viaNode(file, source) : null;
    }
    // npm wrapper (bob, bob.cmd, bob.ps1): the package lives next to it.
    const siblingEntry = pathMod.join(pathMod.dirname(file), ENTRY_FROM_PREFIX);
    if (exists(siblingEntry)) return viaNode(siblingEntry, `${source} (npm wrapper → bobshell entry point)`);

    // A symlinked bin (typical on macOS/Linux) resolves straight to bob.js.
    try {
      const real = realpath(file);
      if (SCRIPT_ENTRY.test(real) && exists(real)) return viaNode(real, `${source} (symlink → ${real})`);
    } catch {
      // not a symlink / not resolvable — fall through
    }

    if (WINDOWS_WRAPPER.test(file)) return null; // never spawn a .cmd/.ps1 directly
    if (platform === 'win32' && !/\.exe$/i.test(file)) return null; // extensionless sh wrapper
    return { ok: true, launch: { command: file, prefixArgs: [], entryPoint: null, source } };
  };

  // 1. Explicit BOB_CLI_PATH (anything other than the bare default "bob").
  const configured = env['BOB_CLI_PATH']?.trim();
  if (configured && configured !== 'bob') {
    if (!exists(configured)) {
      return { ok: false, error: `BOB_CLI_PATH points to "${configured}", which does not exist.` };
    }
    return (
      fromFile(configured, 'BOB_CLI_PATH') ?? {
        ok: false,
        error:
          `BOB_CLI_PATH "${configured}" is a shell wrapper whose bobshell entry point could not be found. ` +
          'Set BOB_CLI_PATH to the bobshell dist/bob.js file instead.',
      }
    );
  }

  // 2. Search PATH for the bob wrapper/binary.
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const dirs = pathVar.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const names = platform === 'win32' ? ['bob.cmd', 'bob.exe', 'bob.ps1', 'bob'] : ['bob'];
  const found: string[] = [];

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = pathMod.join(dir, name);
      if (!exists(candidate)) continue;
      found.push(candidate);
      const res = fromFile(candidate, `PATH (${candidate})`);
      if (res) return res;
    }
  }

  // 3. Default npm global prefix on Windows (%APPDATA%\npm), in case PATH lacks it.
  if (platform === 'win32' && env['APPDATA']) {
    const entry = pathMod.join(env['APPDATA'], 'npm', ENTRY_FROM_PREFIX);
    if (exists(entry)) return viaNode(entry, 'default npm global prefix (%APPDATA%\\npm)');
  }

  if (found.length > 0) {
    return {
      ok: false,
      error:
        `Found Bob wrapper(s) ${found.join(', ')} but could not resolve the bobshell entry point; ` +
        'refusing to launch a shell wrapper. Set BOB_CLI_PATH to the bobshell dist/bob.js file.',
    };
  }
  return {
    ok: false,
    error: 'Bob Shell CLI not found on PATH. Install it (npm package "bobshell") or set BOB_CLI_PATH.',
  };
}

function defaultFileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
