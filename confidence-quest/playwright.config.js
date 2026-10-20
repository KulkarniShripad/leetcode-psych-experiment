import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 3987;
export const E2E_ADMIN_TOKEN = 'e2e-admin-token-0123456789';
const dbPath = path.join(os.tmpdir(), `cq-e2e-${Date.now()}.sqlite`);
// With TEST_DATABASE_URL set, the browser tests run against Postgres (a fresh schema) instead.
const store = process.env.TEST_DATABASE_URL
  ? { DATABASE_URL: process.env.TEST_DATABASE_URL, PG_SCHEMA: `e2e_${Date.now()}` }
  : { DB_PATH: dbPath };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120000,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1000, height: 900 } },
  webServer: {
    command: 'node server/index.js',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), ...store, ADMIN_TOKEN: E2E_ADMIN_TOKEN, ALLOCATION_SEED: 'e2e-seed', NODE_ENV: 'test' },
  },
});
