/**
 * Security controls: repository allow-list (S1), server binding (S2), WebSocket and
 * request Origin policy (S3), input limits (S4), no dynamic SQL keys (S6).
 * Uses a real HTTP server on an ephemeral loopback port and real WebSocket clients.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

process.env['DB_PATH'] = ':memory:';
delete process.env['FORGEGUARD_ALLOWED_REPOS'];
delete process.env['FORGEGUARD_ALLOWED_ORIGINS'];
delete process.env['FORGEGUARD_HOST'];

import { getDatabase } from '../src/db/database';
import { createApp } from '../src/app';
import { startServer, type StartedServer } from '../src/server';
import { DEFAULT_HOST, MAX_ISSUE_TEXT_LENGTH, getAllowedOrigins, getServerHost } from '../src/config';
import { DEFAULT_REPO, resolveAllowedRepo } from '../src/security/repoPolicy';
import { updateMissionStatus } from '../src/pipeline/PhaseRunner';
import { cleanupRepos, makeDir, makeRepo } from './helpers/gitRepo';

const ALLOWED_ORIGIN = 'http://localhost:5173';
let api: http.Server;
let base = '';

beforeAll(async () => {
  getDatabase();
  api = http.createServer(createApp({}));
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
  cleanupRepos();
});

async function createMission(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}/api/missions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, body: parsed, text };
}

const missionCount = (): number => (getDatabase().prepare('SELECT COUNT(*) AS n FROM missions').get() as { n: number }).n;
const junction = (target: string, at: string): void => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

describe('S1 — repository allow-list', () => {
  it('defaults to the bundled demo-app only', async () => {
    const r = await createMission({ issueText: 'fix pricing' });
    expect(r.status).toBe(201);
    expect(r.body['repo_path']).toBe(fs.realpathSync.native(DEFAULT_REPO));
  });

  it('1. rejects a repoPath outside the allow-list with REPO_NOT_ALLOWED and no path echo', async () => {
    const outside = makeRepo();
    const before = missionCount();
    const r = await createMission({ issueText: 'x', repoPath: outside });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ code: 'REPO_NOT_ALLOWED', error: 'Repository path is not in the allow-list' });
    expect(r.text).not.toContain(path.basename(outside));
    expect(missionCount()).toBe(before);

    for (const p of ['C:/Windows', '/etc', 'demo-app', '../demo-app', '']) {
      const res = await createMission({ issueText: 'x', repoPath: p });
      if (p === '') expect(res.status).toBe(201); // empty = default repository
      else expect(res.status, p).toBe(403);
    }
    expect((await createMission({ issueText: 'x', repoPath: 42 })).body['code']).toBe('INVALID_REPO_PATH');
  });

  it('2. path traversal is resolved canonically: escaping is rejected, a no-op ".." is normalised', async () => {
    const escape = await createMission({ issueText: 'x', repoPath: path.join(DEFAULT_REPO, '..', 'backend') });
    expect(escape.status).toBe(403);
    const sameRepo = await createMission({ issueText: 'x', repoPath: `${DEFAULT_REPO}${path.sep}..${path.sep}demo-app` });
    expect(sameRepo.status).toBe(201);
    expect(sameRepo.body['repo_path']).toBe(fs.realpathSync.native(DEFAULT_REPO)); // stored canonically, no ".."
  });

  it('3. canonical path / symlink escape: a link inside an allowed repo that points outside is rejected', () => {
    const allowed = makeRepo();
    const outside = makeDir();
    junction(outside, path.join(allowed, 'escape'));
    const env = { FORGEGUARD_ALLOWED_REPOS: allowed };
    expect(resolveAllowedRepo(allowed, env)).toEqual({ ok: true, path: allowed });
    expect(resolveAllowedRepo(path.join(allowed, 'escape'), env)).toMatchObject({ ok: false, code: 'REPO_NOT_ALLOWED' });
    // A subdirectory of an allowed repository is not itself allowed (exact match, not prefix).
    fs.mkdirSync(path.join(allowed, 'sub'));
    expect(resolveAllowedRepo(path.join(allowed, 'sub'), env)).toMatchObject({ ok: false });
    // A sibling whose name merely starts with the allowed path (a string-prefix check would pass it).
    const sibling = `${allowed}-evil`;
    fs.mkdirSync(sibling);
    try {
      expect(resolveAllowedRepo(sibling, env)).toMatchObject({ ok: false, code: 'REPO_NOT_ALLOWED' });
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
    // A link elsewhere that points at the allowed repository resolves to the same canonical repository.
    const linkParent = makeDir();
    junction(allowed, path.join(linkParent, 'alias'));
    expect(resolveAllowedRepo(path.join(linkParent, 'alias'), env)).toEqual({ ok: true, path: allowed });
  });

  it('FORGEGUARD_ALLOWED_REPOS replaces the default; relative and missing entries are ignored', () => {
    const a = makeRepo();
    const env = { FORGEGUARD_ALLOWED_REPOS: ['relative/repo', path.join(a, 'missing'), a].join(path.delimiter) };
    expect(resolveAllowedRepo(undefined, env)).toEqual({ ok: true, path: a });
    expect(resolveAllowedRepo(DEFAULT_REPO, env)).toMatchObject({ ok: false });
  });
});

describe('S4 — input limits', () => {
  it('4. rejects issueText longer than the limit before anything reaches the pipeline', async () => {
    const before = missionCount();
    const r = await createMission({ issueText: 'x'.repeat(MAX_ISSUE_TEXT_LENGTH + 1) });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'ISSUE_TEXT_TOO_LONG', maxLength: 12_000, length: 12_001 });
    expect(missionCount()).toBe(before);
    expect((await createMission({ issueText: 'x'.repeat(MAX_ISSUE_TEXT_LENGTH) })).status).toBe(201);
  });

  it('rejects oversized bodies, invalid JSON and a non-string issueText with structured errors', async () => {
    expect(await createMission({ issueText: 'x'.repeat(200_000) })).toMatchObject({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(await createMission('{"issueText": ')).toMatchObject({ status: 400, body: { code: 'INVALID_JSON' } });
    expect(await createMission({ issueText: ['array'] })).toMatchObject({ status: 400, body: { code: 'ISSUE_TEXT_REQUIRED' } });
  });
});

describe('S3 — Origin policy', () => {
  it('REST: a state-changing request from an unknown origin is refused; the dev origin is accepted', async () => {
    const before = missionCount();
    const evil = await createMission({ issueText: 'x' }, { origin: 'https://evil.example' });
    expect(evil).toMatchObject({ status: 403, body: { code: 'ORIGIN_NOT_ALLOWED' } });
    expect(missionCount()).toBe(before);
    const ok = await createMission({ issueText: 'x' }, { origin: ALLOWED_ORIGIN });
    expect(ok.status).toBe(201);
  });

  it('wildcard and invalid origins are never accepted from configuration', () => {
    expect(getAllowedOrigins({})).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(getAllowedOrigins({ FORGEGUARD_ALLOWED_ORIGINS: '*, not a url, https://app.example.com/' })).toEqual(['https://app.example.com']);
  });

  describe('WebSocket', () => {
    let srv: StartedServer;
    beforeAll(async () => { srv = await startServer({ port: 0, env: {} }); });
    afterAll(async () => { await srv.close(); });

    function connect(origin?: string): Promise<'open' | number> {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, origin ? { origin } : {});
        ws.on('open', () => { ws.close(); resolve('open'); });
        ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? -1); res.resume(); });
        ws.on('error', () => resolve(-1));
      });
    }

    it('5. an unauthorised browser Origin is rejected (403)', async () => {
      expect(await connect('https://evil.example')).toBe(403);
      expect(await connect('null')).toBe(403);
      expect(await connect('http://localhost:5174')).toBe(403);
    });

    it('6. the allowed Vite dev origins are accepted', async () => {
      expect(await connect('http://localhost:5173')).toBe('open');
      expect(await connect('http://127.0.0.1:5173')).toBe('open');
    });

    it('a non-browser client without Origin is accepted (local tooling on the loopback interface)', async () => {
      expect(await connect()).toBe('open');
    });

    it('7. the server binds to 127.0.0.1 by default', () => {
      expect(srv.host).toBe('127.0.0.1');
      expect((srv.server.address() as AddressInfo).address).toBe('127.0.0.1');
    });
  });
});

describe('S2 — server binding', () => {
  it('7. defaults to loopback; another interface only by explicit FORGEGUARD_HOST', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(getServerHost({})).toBe('127.0.0.1');
    expect(getServerHost({ FORGEGUARD_HOST: '  ' })).toBe('127.0.0.1');
    expect(getServerHost({ FORGEGUARD_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

describe('S6 — no dynamic SQL keys', () => {
  it('8. column names outside the allow-list are refused before any SQL runs', () => {
    const id = 'sql-key-test';
    getDatabase().prepare(`INSERT INTO missions (id, issue_text, repo_path, status) VALUES (?, 'x', 'r', 'created')`).run(id);
    const injected = { "status = 'complete', error_message": 'pwned' } as unknown as Record<'error_message', string>;
    expect(() => updateMissionStatus(id, 'analyzing', injected)).toThrow(/not updatable/);
    expect(getDatabase().prepare('SELECT status, error_message FROM missions WHERE id = ?').get(id))
      .toEqual({ status: 'created', error_message: null });

    updateMissionStatus(id, 'analyzing', { error_message: "it's fine; DROP TABLE missions;--" });
    expect(getDatabase().prepare('SELECT status, error_message FROM missions WHERE id = ?').get(id))
      .toEqual({ status: 'analyzing', error_message: "it's fine; DROP TABLE missions;--" });
  });
});
