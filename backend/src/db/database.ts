import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let _db: Database.Database | null = null;

/**
 * Return the singleton SQLite database connection.
 * Initialises the database and runs the schema on first call.
 */
export function getDatabase(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env['DB_PATH'] ?? path.join(__dirname, '../../data/forgeguard.db');

  // Ensure the directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);

  // Apply schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  _db.exec(schema);
  migrate(_db);

  console.log(`[db] SQLite database initialised at ${dbPath}`);
  return _db;
}

/** Bring databases created by an older schema.sql up to date (CREATE TABLE IF NOT EXISTS won't). */
function migrate(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(validation_runs)`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'run_kind')) {
    // Every pre-existing row was produced by Phase 5, i.e. post-implementation.
    db.exec(`ALTER TABLE validation_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'post' CHECK(run_kind IN ('baseline','post'))`);
  }
  if (!columns.some((c) => c.name === 'timed_out')) {
    db.exec(`ALTER TABLE validation_runs ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0 CHECK(timed_out IN (0, 1))`);
  }
}

/**
 * Close the database connection (for graceful shutdown / tests).
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
