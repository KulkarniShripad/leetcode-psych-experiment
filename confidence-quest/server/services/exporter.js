import { getMeta } from '../db/connection.js';
import { scoreRaw } from './scoring.js';
import { SURVEY_PHASES, itemsForPhase, measureMean, optionLabel, scoredValue } from './surveyScoring.js';
import { computeGameState, levelFor } from './gamification.js';

// All research exports are built on demand from the raw tables. Pilot rows are excluded;
// `pilot = true` gives the opposite (pilot rows only) for reviewing the pilot.

export const EXPORTS = {
  participants: 'participants.csv',
  questions: 'questions_long.csv',
  surveys: 'surveys_long.csv',
  events: 'events.csv',
  gamification: 'gamification_events.csv',
  allocation: 'allocation.csv',
  meta: 'meta.csv',
};

function cell(value) {
  if (value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))) return '';
  const s = typeof value === 'number' ? String(Number(value.toFixed(4))) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  return [columns.join(','), ...rows.map((row) => columns.map((c) => cell(row[c])).join(','))].join('\n') + '\n';
}

const armCode = (arm) => (arm === 'control' ? 0 : arm === 'experimental' ? 1 : null);

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

// One column per survey answer, in the order participants saw them. Items asked in more than
// one survey (C1-C6) get the phase as a suffix (C1_pre, C1_post); choice items also get a label.
function itemColumns(survey) {
  const phasesOf = new Map();
  for (const phase of SURVEY_PHASES) {
    for (const item of itemsForPhase(survey, phase)) phasesOf.set(item.id, [...(phasesOf.get(item.id) ?? []), phase]);
  }
  const columns = [];
  for (const phase of SURVEY_PHASES) {
    for (const item of itemsForPhase(survey, phase)) {
      const name = phasesOf.get(item.id).length > 1 ? `${item.id}_${phase}` : item.id;
      columns.push({ name, item, phase });
      if (item.type === 'choice') columns.push({ name: `${name}_label`, item, phase, label: true });
    }
  }
  return columns;
}

export async function participantsCsv(db, content, pilot = false) {
  const { survey, gamification, questions } = content;
  const people = await db.all('SELECT * FROM participants WHERE is_pilot = ? ORDER BY started_at, id', [pilot ? 1 : 0]);
  const responses = groupBy(
    await db.all('SELECT * FROM question_responses WHERE answered_at IS NOT NULL OR expired = 1 ORDER BY position'),
    'participant_id',
  );
  const surveys = groupBy(await db.all('SELECT * FROM survey_responses'), 'participant_id');
  const views = groupBy(await db.all("SELECT * FROM gamification_events WHERE type = 'leaderboard_view' ORDER BY id"), 'participant_id');
  const postdiction = SURVEY_PHASES.flatMap((phase) => itemsForPhase(survey, phase).map((item) => ({ item, phase }))).find(
    (e) => e.item.measure === 'postdiction',
  );
  const items = itemColumns(survey);

  const columns = [
    'participant_code', 'arm', 'arm_code', 'status', 'last_step', 'started_at_utc', 'completed_at_utc', 'duration_s',
    'questions_answered', 'score_raw', 'pre_conf_mean', 'post_conf_mean', 'conf_change',
  ];
  if (postdiction) columns.push('calibration_gap');
  columns.push(...items.map((c) => c.name));
  columns.push('tokens_total', 'badges_earned', 'best_streak', 'level_reached', 'rank_shown', 'rank_pool_size', 'consent_version');

  const rows = people.map((p) => {
    const answered = responses.get(p.id) ?? [];
    const values = Object.fromEntries(SURVEY_PHASES.map((phase) => [phase, {}]));
    for (const s of surveys.get(p.id) ?? []) values[s.phase][s.item_id] = s.value;
    const pre = measureMean(survey, 'confidence', 'pre', values.pre);
    const post = measureMean(survey, 'confidence', 'post', values.post);
    const score = p.questions_finished_at !== null ? scoreRaw(answered) : null;
    const row = {
      participant_code: p.participant_code,
      arm: p.arm,
      arm_code: armCode(p.arm),
      status: p.status,
      last_step: p.current_step,
      started_at_utc: p.started_at,
      completed_at_utc: p.completed_at,
      duration_s: p.completed_at ? Math.round((Date.parse(p.completed_at) - Date.parse(p.started_at)) / 1000) : null,
      questions_answered: answered.filter((r) => r.selected_option !== null).length,
      score_raw: score,
      pre_conf_mean: pre,
      post_conf_mean: post,
      conf_change: pre !== null && post !== null ? post - pre : null,
      consent_version: p.consent_version,
    };
    if (postdiction) {
      const guess = values[postdiction.phase][postdiction.item.id];
      row.calibration_gap = guess !== undefined && score !== null ? guess - score : null;
    }
    for (const c of items) {
      const value = values[c.phase][c.item.id];
      row[c.name] = value === undefined ? null : c.label ? optionLabel(c.item, value) : value;
    }
    if (p.arm === 'experimental') {
      const state = computeGameState(gamification, questions, answered);
      row.tokens_total = gamification.tokens.enabled ? state.tokens_total : null;
      row.badges_earned = gamification.badges.enabled ? state.badges.length : null;
      row.best_streak = gamification.streaks.enabled ? state.best_streak : null;
      row.level_reached = gamification.levels.enabled ? levelFor(gamification, state.tokens_total).number : null;
      const firstView = views.get(p.id) ?? [];
      row.rank_shown = firstView.find((v) => v.key === 'rank')?.value ?? null;
      row.rank_pool_size = firstView.find((v) => v.key === 'pool_size')?.value ?? null;
    }
    return row;
  });
  return toCsv(columns, rows);
}

export async function questionsCsv(db, content, pilot = false) {
  const rows = (
    await db.all(
      `SELECT p.participant_code, p.arm, q.* FROM question_responses q JOIN participants p ON p.id = q.participant_id
       WHERE p.is_pilot = ? ORDER BY p.started_at, p.id, q.position`,
      [pilot ? 1 : 0],
    )
  ).map((r) => {
    const q = content.questionsById[r.question_id];
    return {
      ...r,
      section: q?.section,
      difficulty_label: q?.difficulty_label,
      response_status: r.answered_at ? 'answered' : r.expired ? 'expired' : 'not_answered',
      shown_at_utc: r.shown_at,
      answered_at_utc: r.answered_at,
    };
  });
  return toCsv(
    [
      'participant_code', 'arm', 'question_id', 'section', 'selected_option', 'is_correct', 'time_taken_ms', 'answered_at_utc',
      'position', 'difficulty_label', 'response_status', 'shown_at_utc',
    ],
    rows,
  );
}

export async function surveysCsv(db, content, pilot = false) {
  const byId = Object.fromEntries(content.survey.items.map((i) => [i.id, i]));
  const phaseOrder = Object.fromEntries(SURVEY_PHASES.map((phase, i) => [phase, i]));
  const raw = await db.all(
    `SELECT p.participant_code, p.arm, s.phase, s.item_id, s.value, s.id FROM survey_responses s
     JOIN participants p ON p.id = s.participant_id
     WHERE p.is_pilot = ? ORDER BY p.started_at, p.id, s.id`,
    [pilot ? 1 : 0],
  );
  // Participants in start order; within each, pre -> post_a -> post, then the order items were stored.
  const personIndex = new Map();
  for (const r of raw) if (!personIndex.has(r.participant_code)) personIndex.set(r.participant_code, personIndex.size);
  const sortKey = (r) => [personIndex.get(r.participant_code), phaseOrder[r.phase], r.id];
  const rows = raw
    .sort((a, b) => {
      const [ka, kb] = [sortKey(a), sortKey(b)];
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    })
    .map((r) => {
      const item = byId[r.item_id];
      return {
        ...r,
        value_label: optionLabel(item, r.value),
        measure: item?.measure,
        reverse: item ? (item.reverse ? 1 : 0) : null,
        value_scored: item ? scoredValue(item, r.value) : null,
      };
    });
  return toCsv(['participant_code', 'arm', 'phase', 'item_id', 'value', 'value_label', 'measure', 'reverse', 'value_scored'], rows);
}

export async function eventsCsv(db, content, pilot = false) {
  const rows = await db.all(
    `SELECT p.participant_code, e.event_type, e.payload, e.created_at AS created_at_utc FROM events e
     LEFT JOIN participants p ON p.id = e.participant_id
     WHERE e.participant_id IS NULL OR p.is_pilot = ? ORDER BY e.id`,
    [pilot ? 1 : 0],
  );
  return toCsv(['participant_code', 'event_type', 'payload', 'created_at_utc'], rows);
}

export async function gamificationCsv(db, content, pilot = false) {
  const rows = await db.all(
    `SELECT p.participant_code, g.type, g.key, g.value, g.created_at AS created_at_utc FROM gamification_events g
     JOIN participants p ON p.id = g.participant_id WHERE p.is_pilot = ? ORDER BY g.id`,
    [pilot ? 1 : 0],
  );
  return toCsv(['participant_code', 'type', 'key', 'value', 'created_at_utc'], rows);
}

export async function allocationCsv(db, content, pilot = false) {
  const seed = await getMeta(db, 'allocation_seed');
  const blockSize = await getMeta(db, 'allocation_block_size');
  const rows = (
    await db.all(
      `SELECT s.*, CASE WHEN p.is_pilot = ? THEN p.participant_code END AS participant_code
       FROM allocation_slots s LEFT JOIN participants p ON p.id = s.claimed_by ORDER BY s.list, s.seq_no`,
      [pilot ? 1 : 0],
    )
  ).map((s) => ({ ...s, seed, block_size: blockSize, claimed: s.claimed_by ? 1 : 0, claimed_at_utc: s.claimed_at }));
  return toCsv(['seed', 'block_size', 'list', 'seq_no', 'block_no', 'arm', 'claimed', 'participant_code', 'claimed_at_utc'], rows);
}

export async function metaCsv(db, content) {
  const rows = await db.all("SELECT key, value FROM meta WHERE key NOT LIKE 'content_hash:%' ORDER BY key");
  rows.push({ key: 'storage', value: db.dialect });
  rows.push({ key: 'questions_version', value: content.questionsVersion });
  for (const [file, hash] of Object.entries(content.hashes)) rows.push({ key: `content_sha256:${file}`, value: hash });
  rows.push({ key: 'exported_at_utc', value: new Date().toISOString() });
  return toCsv(['key', 'value'], rows);
}

const BUILDERS = {
  participants: participantsCsv,
  questions: questionsCsv,
  surveys: surveysCsv,
  events: eventsCsv,
  gamification: gamificationCsv,
  allocation: allocationCsv,
  meta: metaCsv,
};

export async function buildExport(db, content, name, { pilot = false } = {}) {
  const build = BUILDERS[name];
  return build ? build(db, content, pilot) : null;
}
