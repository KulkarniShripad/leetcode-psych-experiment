import fs from 'node:fs';
import { getMeta, setMeta } from './connection.js';

export const SCHEMA_VERSION = '2';

const schemaFor = (dialect) => fs.readFileSync(new URL(`./schema.${dialect}.sql`, import.meta.url), 'utf8');

// v1 -> v2: the survey gained a third phase (post_a, asked before the score is shown).
// SQLite cannot change a CHECK constraint in place, so the table is rebuilt.
const SQLITE_V1_TO_V2 = `
  CREATE TABLE survey_responses_v2 (
    id             INTEGER PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    phase          TEXT NOT NULL CHECK (phase IN ('pre', 'post_a', 'post')),
    item_id        TEXT NOT NULL,
    value          INTEGER NOT NULL,
    submitted_at   TEXT NOT NULL,
    UNIQUE (participant_id, phase, item_id)
  );
  INSERT INTO survey_responses_v2 SELECT id, participant_id, phase, item_id, value, submitted_at FROM survey_responses;
  DROP TABLE survey_responses;
  ALTER TABLE survey_responses_v2 RENAME TO survey_responses;
`;

// Builds the database if it is empty and upgrades an older one. Safe to run on every start,
// and on Postgres safe even when two app instances start at the same moment.
export async function migrate(db) {
  const schema = db.describe().schema;
  if (db.dialect === 'postgres' && schema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`PG_SCHEMA "${schema}" must be lowercase letters, digits and _`);
    await db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  }
  await db.transaction(async () => {
    await db.lockGlobal();
    const existing = (await db.tableExists('meta')) ? await getMeta(db, 'schema_version') : null;
    if (existing === '1' && db.dialect === 'sqlite') {
      await db.exec(SQLITE_V1_TO_V2);
    } else if (existing && existing !== SCHEMA_VERSION) {
      throw new Error(`Database schema version ${existing} does not match this code (${SCHEMA_VERSION}).`);
    }
    await db.exec(schemaFor(db.dialect));
    if (existing !== SCHEMA_VERSION) await setMeta(db, 'schema_version', SCHEMA_VERSION);
  });
}
