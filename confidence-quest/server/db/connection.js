import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

// One async database interface with two back ends:
//   - SQLite (better-sqlite3): local development, tests, the laptop fallback. Data in one file.
//   - Postgres (node-postgres): the hosted study. Data in a managed cloud database (Neon, Supabase).
//
// SQL is written once, with `?` placeholders and syntax both understand. Queries made anywhere
// inside db.transaction(...) automatically run inside that transaction (AsyncLocalStorage).
//
// db.all(sql, params) -> rows        db.get(sql, params) -> row | undefined
// db.run(sql, params) -> {changes}   db.exec(script)     db.transaction(async () => ...)
// db.forUpdate / db.skipLocked: row-locking suffixes ('' on SQLite, where a write
// transaction already locks the whole database).

const RETRYABLE_PG = new Set(['40001', '40P01', '23505']); // serialization, deadlock, unique race

// COUNT(*) and SUM() come back as int8/numeric strings from Postgres; the numbers here are small.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export async function openDatabase({ databaseUrl, dbPath, pgSchema, pgPoolMax } = {}) {
  return databaseUrl ? openPostgres(databaseUrl, { schema: pgSchema, max: pgPoolMax }) : openSqlite(dbPath);
}

// ---------- SQLite ----------

export function openSqlite(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  // FULL keeps every committed answer even through a power cut; the write volume is tiny.
  raw.pragma('synchronous = FULL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const direct = {
    all: async (sql, params = []) => stmt(sql).all(...params),
    get: async (sql, params = []) => stmt(sql).get(...params),
    run: async (sql, params = []) => ({ changes: stmt(sql).run(...params).changes }),
    exec: async (sql) => void raw.exec(sql),
    lockGlobal: async () => {},
  };

  // One connection: transactions take turns, and queries outside a transaction wait for the
  // running one to finish, so nothing ever lands inside someone else's transaction.
  const als = new AsyncLocalStorage();
  let tail = Promise.resolve();
  const exclusive = (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
  const route = (name) => (...args) => (als.getStore() ? direct[name](...args) : exclusive(() => direct[name](...args)));

  return {
    dialect: 'sqlite',
    forUpdate: '',
    skipLocked: '',
    describe: () => ({ kind: 'sqlite', file: dbPath }),
    all: route('all'),
    get: route('get'),
    run: route('run'),
    exec: route('exec'),
    lockGlobal: direct.lockGlobal,
    transaction(fn) {
      if (als.getStore()) return fn();
      return exclusive(() =>
        als.run(true, async () => {
          raw.exec('BEGIN IMMEDIATE');
          try {
            const result = await fn();
            raw.exec('COMMIT');
            return result;
          } catch (err) {
            if (raw.inTransaction) raw.exec('ROLLBACK');
            throw err;
          }
        }),
      );
    },
    tableExists: async (name) =>
      Boolean(stmt("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)),
    listColumns: async () =>
      stmt("SELECT m.name AS table_name, p.name AS column_name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'").all(),
    // Consistent file copy, even while participants are answering.
    backupFile: (file) => raw.backup(file),
    raw,
    close: async () => raw.close(),
  };
}

// ---------- Postgres ----------

// `?` -> `$1, $2, ...` (none of our SQL has a literal question mark).
const pgSqlCache = new Map();
function toPg(sql) {
  let out = pgSqlCache.get(sql);
  if (!out) {
    let i = 0;
    out = sql.replace(/\?/g, () => `$${++i}`);
    pgSqlCache.set(sql, out);
  }
  return out;
}

export function openPostgres(url, { schema, max = 10 } = {}) {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 10000,
    options: schema ? `-c search_path=${schema}` : undefined,
  });
  pool.on('error', (err) => console.error('[db] idle Postgres connection error:', err.message));
  const als = new AsyncLocalStorage();
  const on = (client) => ({
    all: async (sql, params = []) => (await client.query(toPg(sql), params)).rows,
    get: async (sql, params = []) => (await client.query(toPg(sql), params)).rows[0],
    run: async (sql, params = []) => ({ changes: (await client.query(toPg(sql), params)).rowCount ?? 0 }),
    exec: async (sql) => void (await client.query(sql)),
    // Serialises one-off jobs (start-up, extending the allocation list) across app instances.
    lockGlobal: async () => void (await client.query('SELECT pg_advisory_xact_lock(4242)')),
  });
  const outside = on(pool);
  const route = (name) => (...args) => (als.getStore() ?? outside)[name](...args);

  return {
    dialect: 'postgres',
    forUpdate: ' FOR UPDATE',
    skipLocked: ' FOR UPDATE SKIP LOCKED',
    describe: () => ({ kind: 'postgres', host: new URL(url).hostname, schema: schema ?? null }),
    all: route('all'),
    get: route('get'),
    run: route('run'),
    exec: route('exec'),
    lockGlobal: route('lockGlobal'),
    async transaction(fn) {
      if (als.getStore()) return fn();
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await als.run(on(client), fn);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          // Two requests racing for the same row: the whole transaction is safe to run again.
          if (attempt < 4 && RETRYABLE_PG.has(err.code)) continue;
          throw err;
        } finally {
          client.release();
        }
      }
    },
    tableExists: async (name) => Boolean((await outside.get('SELECT to_regclass(?) AS t', [name]))?.t),
    listColumns: async () =>
      outside.all('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()'),
    backupFile: null,
    pool,
    close: async () => pool.end(),
  };
}

// ---------- meta ----------

export async function getMeta(db, key) {
  return (await db.get('SELECT value FROM meta WHERE key = ?', [key]))?.value ?? null;
}

export async function setMeta(db, key, value) {
  await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
    key,
    String(value),
  ]);
}
