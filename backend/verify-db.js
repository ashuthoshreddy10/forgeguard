require('dotenv').config({ path: '../.env' });
const { getDatabase, closeDatabase } = require('./src/db/database');
try {
  const db = getDatabase();
  console.log('DB init OK');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', tables.map(t => t.name).join(', '));
  closeDatabase();
  console.log('DB close OK');
} catch (err) {
  console.error('DB ERROR:', err.message);
  process.exit(1);
}
