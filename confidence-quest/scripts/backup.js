// Saves a backup of all study data to data/backups/.
//   Local SQLite: a consistent copy of the database file (safe while the server is running).
//   Cloud Postgres (DATABASE_URL set): every table as one JSON file.
// Usage: node scripts/backup.js [label]     e.g.  node scripts/backup.js before-session-1
// Then copy the file somewhere safe (USB stick, shared drive).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/connection.js';
import { migrate } from '../server/db/migrate.js';
import { backupDatabaseFile, dumpDatabase } from '../server/services/maintenance.js';

const config = loadConfig();
const label = (process.argv[2] ?? 'script').replace(/[^a-z0-9_-]/gi, '');
const db = await openDatabase(config);
await migrate(db);
let file = await backupDatabaseFile(db, config.backupDir, label);
if (!file) {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const dump = await dumpDatabase(db);
  file = path.join(config.backupDir, `backup-${dump.exported_at_utc.replace(/[:.]/g, '-')}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 1));
}
await db.close();
console.log(`Backup written: ${file}`);
