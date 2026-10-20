import { afterEach } from 'vitest';
import { closeAllApps } from './helpers.js';

// Every test app opens a database connection (or a Postgres pool); close them after each test.
afterEach(async () => {
  await closeAllApps();
});
