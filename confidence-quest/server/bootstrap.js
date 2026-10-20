import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { loadConfig } from './config.js';
import { loadContent } from './services/content.js';
import { ensureAllocation } from './services/assignment.js';
import { ensureStudyMode, recordContentHashes } from './services/maintenance.js';

// Checks content, connects to the database (SQLite file, or Postgres when DATABASE_URL is set),
// builds or upgrades the tables and prepares allocation. Shared by the server and scripts.
export async function bootstrap(config = loadConfig()) {
  const content = loadContent(config.contentDir);
  const db = await openDatabase(config);
  try {
    await migrate(db);
    await ensureStudyMode(db, config.initialStudyMode);
    const warnings = [...content.warnings, ...(await ensureAllocation(db, content.study.allocation, config.allocationSeed))];
    const changed = await recordContentHashes(db, content);
    if (changed.length) warnings.push(`Content changed since the last start: ${changed.join(', ')} (logged in events).`);
    return { config, content, db, warnings };
  } catch (err) {
    await db.close();
    throw err;
  }
}
