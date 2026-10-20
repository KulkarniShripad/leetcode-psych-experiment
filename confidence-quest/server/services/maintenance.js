import fs from 'node:fs';
import path from 'node:path';
import { getMeta, setMeta } from '../db/connection.js';
import { STEPS } from './stateMachine.js';
import { nowIso } from '../util.js';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const TABLES = ['meta', 'allocation_slots', 'participants', 'survey_responses', 'question_responses', 'gamification_events', 'events'];

const systemEvent = (db, type, payload) =>
  db.run('INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (NULL, ?, ?, ?)', [
    type,
    payload === null ? null : JSON.stringify(payload),
    nowIso(),
  ]);

// Every table as JSON: a complete copy that works the same for SQLite and the cloud database.
export async function dumpDatabase(db) {
  const tables = {};
  for (const table of TABLES) tables[table] = await db.all(`SELECT * FROM ${table} ORDER BY 1`);
  await systemEvent(db, 'backup_downloaded', { rows: Object.values(tables).reduce((n, rows) => n + rows.length, 0) });
  return { exported_at_utc: nowIso(), storage: db.describe(), tables };
}

// SQLite only: a consistent copy of the database file (safe while participants are answering).
export async function backupDatabaseFile(db, backupDir, label = 'manual') {
  if (!db.backupFile) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `app-${stamp()}-${label.replace(/[^a-z0-9_-]/gi, '')}.sqlite`);
  await db.backupFile(file);
  await systemEvent(db, 'backup_taken', { file: path.basename(file) });
  return file;
}

// Records the hash of every content file and logs when one changes between starts.
export async function recordContentHashes(db, content) {
  const changed = [];
  await db.transaction(async () => {
    await db.lockGlobal();
    for (const [file, hash] of Object.entries(content.hashes)) {
      const key = `content_hash:${file}`;
      const previous = await getMeta(db, key);
      if (previous !== hash) {
        if (previous) changed.push(file);
        await setMeta(db, key, hash);
      }
    }
    if (changed.length) await systemEvent(db, 'content_changed', { files: changed });
  });
  return changed;
}

export async function ensureStudyMode(db, initialMode) {
  await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING', ['study_mode', initialMode]);
}

export async function setStudyMode(db, mode) {
  await setMeta(db, 'study_mode', mode);
  await systemEvent(db, 'study_mode_changed', { mode });
}

function summarise(rows) {
  const out = { total: rows.length, by_status: {}, by_step: {}, by_arm: {} };
  for (const step of STEPS) out.by_step[step] = 0;
  for (const arm of ['control', 'experimental', 'unassigned']) {
    out.by_arm[arm] = { total: 0, in_progress: 0, completed: 0, abandoned: 0, withdrawn: 0 };
  }
  for (const row of rows) {
    out.by_status[row.status] = (out.by_status[row.status] ?? 0) + 1;
    if (row.status === 'in_progress') out.by_step[row.current_step] = (out.by_step[row.current_step] ?? 0) + 1;
    const arm = out.by_arm[row.arm ?? 'unassigned'];
    arm.total++;
    arm[row.status]++;
  }
  return out;
}

export async function studyStatus(db, content, startedAt) {
  const participants = await db.all('SELECT is_pilot, arm, status, current_step FROM participants');
  const slots = await db.all('SELECT list, COUNT(*) AS total, COUNT(claimed_by) AS claimed FROM allocation_slots GROUP BY list');
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await db.all("SELECT payload, created_at FROM events WHERE event_type = 'error' ORDER BY id DESC LIMIT 10");
  return {
    now_utc: nowIso(),
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    storage: db.describe(),
    study_mode: await getMeta(db, 'study_mode'),
    live: summarise(participants.filter((p) => p.is_pilot === 0)),
    pilot: summarise(participants.filter((p) => p.is_pilot === 1)),
    allocation: {
      seed_source: await getMeta(db, 'allocation_seed_source'),
      block_size: Number(await getMeta(db, 'allocation_block_size')),
      lists: Object.fromEntries(slots.map((s) => [s.list, { total: s.total, claimed: s.claimed, remaining: s.total - s.claimed }])),
    },
    errors_last_hour: (await db.get("SELECT COUNT(*) AS n FROM events WHERE event_type = 'error' AND created_at >= ?", [hourAgo])).n,
    recent_errors: recent.map((e) => ({ ...JSON.parse(e.payload), at: e.created_at })),
    content: {
      questions_version: content.questionsVersion,
      warnings: content.warnings,
      sha256: Object.fromEntries(Object.entries(content.hashes).map(([f, h]) => [f, h.slice(0, 12)])),
    },
  };
}

async function deleteParticipantData(db, ids) {
  for (const table of ['survey_responses', 'question_responses', 'gamification_events', 'events']) {
    for (const id of ids) await db.run(`DELETE FROM ${table} WHERE participant_id = ?`, [id]);
  }
}

// Removes all pilot/rehearsal rows and resets the pilot allocation list.
export async function purgePilotData(db) {
  return db.transaction(async () => {
    await db.lockGlobal();
    const ids = (await db.all('SELECT id FROM participants WHERE is_pilot = 1')).map((r) => r.id);
    // The events table is append-only for updates, but deleting a pilot's rows is allowed.
    await deleteParticipantData(db, ids);
    // Slots and participants point at each other: unlink, delete the people, then the pilot list.
    // (With a shared list, pilots' main-list slots become free again.)
    await db.run(
      'UPDATE allocation_slots SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by IN (SELECT id FROM participants WHERE is_pilot = 1)',
    );
    const removed = (await db.run('DELETE FROM participants WHERE is_pilot = 1')).changes;
    await db.run("DELETE FROM allocation_slots WHERE list = 'pilot'");
    await systemEvent(db, 'pilot_data_purged', { participants: removed });
    return removed;
  });
}

// A participant asked (with their code) for their answers to be removed. The row and its
// allocation slot stay so the allocation sequence is unchanged; everything they answered goes.
export async function withdrawParticipantData(db, participantCode) {
  return db.transaction(async () => {
    const p = await db.get('SELECT id, status FROM participants WHERE participant_code = ?', [participantCode]);
    if (!p) return false;
    await deleteParticipantData(db, [p.id]);
    await db.run(`UPDATE participants SET status = 'withdrawn', leaderboard_name = NULL WHERE id = ?`, [p.id]);
    await db.run('INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)', [
      p.id,
      'data_withdrawn',
      null,
      nowIso(),
    ]);
    return true;
  });
}
