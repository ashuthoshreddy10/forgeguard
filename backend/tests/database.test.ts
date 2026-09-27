/**
 * Schema migration: a database created before `validation_runs.run_kind` existed is upgraded in place.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-migrate-'));
const dbPath = path.join(dir, 'legacy.db');

const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE validation_runs (
    id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, phase_id TEXT, command TEXT NOT NULL,
    exit_code INTEGER, stdout TEXT, stderr TEXT, passed INTEGER CHECK(passed IN (0, 1)),
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), completed_at TEXT, duration_ms INTEGER
  );
  INSERT INTO validation_runs (id, mission_id, command, exit_code, passed) VALUES ('legacy-1', 'm1', 'npm test', 0, 1);
`);
legacy.close();
process.env['DB_PATH'] = dbPath;

const { getDatabase, closeDatabase } = await import('../src/db/database');

afterAll(() => {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('database migration', () => {
  it('adds run_kind to an existing validation_runs table; legacy rows are post-implementation runs', () => {
    const db = getDatabase();
    const cols = (db.prepare('PRAGMA table_info(validation_runs)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('run_kind');
    expect(cols).toContain('timed_out');
    expect(db.prepare(`SELECT run_kind, timed_out FROM validation_runs WHERE id = 'legacy-1'`).get()).toEqual({ run_kind: 'post', timed_out: 0 });
    expect(() => db.prepare(`UPDATE validation_runs SET run_kind = 'other' WHERE id = 'legacy-1'`).run()).toThrow(/CHECK/);
  });
});
