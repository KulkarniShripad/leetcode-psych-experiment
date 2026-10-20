import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { ContentError } from './services/content.js';

async function main() {
  const config = loadConfig();
  if (config.isProduction && config.adminToken.length < 16) {
    console.error('Refusing to start: set ADMIN_TOKEN (at least 16 characters) in production.');
    process.exit(1);
  }
  // Cloud hosts (Render, Vercel) wipe the server's disk on every restart and deploy, and Vercel
  // runs several copies: a local SQLite file there would lose answers. Use a cloud database.
  if (config.onEphemeralHost && !config.databaseUrl) {
    console.error('Refusing to start: this host has no permanent disk. Set DATABASE_URL to your cloud Postgres database (see docs/hosting.md).');
    process.exit(1);
  }
  let boot;
  try {
    boot = await bootstrap(config);
  } catch (err) {
    if (err instanceof ContentError) {
      console.error(`Refusing to start. ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const { db, content, warnings } = boot;
  for (const w of warnings) console.warn(`[warning] ${w}`);
  if (!config.adminToken) console.warn('[warning] ADMIN_TOKEN is not set: the admin status page and exports are disabled.');

  const { app } = createApp({ db, content, config });
  const where = db.dialect === 'postgres' ? `cloud Postgres at ${db.describe().host}` : `SQLite file ${config.dbPath}`;
  const server = app.listen(config.port, config.host, () => {
    console.log(`Confidence Quest listening on port ${config.port}. Data is stored in: ${where}`);
  });

  const shutdown = () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
