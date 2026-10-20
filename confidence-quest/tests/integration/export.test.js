import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../server/config.js';
import { ADMIN_TOKEN, ANSWER_KEY, armOf, contentCopy, fullRun, makeApp, parseCsv, tmpDir, toQuestions, participant, wrongLetter } from '../helpers.js';

const exportCsv = async (app, name) =>
  (await request(app).get(`/admin/api/export/${name}.csv`).set('X-Admin-Token', ADMIN_TOKEN).expect(200)).text;

// The same synthetic study: 4 participants with fixed answers and survey values.
async function syntheticStudy(app, content) {
  const plans = [
    { choose: (id) => ANSWER_KEY[id], preValue: 3, postValue: 5 },
    { choose: (id) => ANSWER_KEY[id], preValue: 4, postValue: 4 },
    { choose: (id, n) => (n % 2 ? wrongLetter(ANSWER_KEY[id]) : ANSWER_KEY[id]), preValue: 2, postValue: 6 },
    { choose: (id) => wrongLetter(ANSWER_KEY[id]), preValue: 5, postValue: 3 },
  ];
  const runs = [];
  for (const plan of plans) runs.push(await fullRun(app, content, plan));
  return runs;
}

// Timestamps, durations and random codes/names differ between runs; everything else must not.
function normalise(csv, runs) {
  let out = csv.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<ts>');
  runs.forEach((run, i) => {
    out = out.split(run.code).join(`<P${i + 1}>`);
  });
  return out;
}

describe('exports', () => {
  it('participants.csv has the analysis columns and correct values', async () => {
    const { app, db, content } = await makeApp();
    const runs = await syntheticStudy(app, content);
    const rows = parseCsv(await exportCsv(app, 'participants'));
    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0])).toEqual([
      'participant_code', 'arm', 'arm_code', 'status', 'last_step', 'started_at_utc', 'completed_at_utc', 'duration_s',
      'questions_answered', 'score_raw', 'pre_conf_mean', 'post_conf_mean', 'conf_change',
      'C1_pre', 'C2_pre', 'C3_pre', 'C4_pre', 'C5_pre', 'C6_pre', 'P1', 'P1_label', 'P2', 'P2_label',
      'C1_post', 'C2_post', 'C3_post', 'C4_post', 'C5_post', 'C6_post', 'Q11', 'Q13', 'Q14', 'Q12', 'Q12_label',
      'tokens_total', 'badges_earned', 'best_streak', 'level_reached', 'rank_shown', 'rank_pool_size', 'consent_version',
    ]);
    const byCode = Object.fromEntries(rows.map((r) => [r.participant_code, r]));
    const first = byCode[runs[0].code];
    // 3 on every confidence item before, 5 after: means 3 and 5, change +2.
    expect(first).toMatchObject({ status: 'completed', score_raw: '9', questions_answered: '9', pre_conf_mean: '3', post_conf_mean: '5', conf_change: '2' });
    expect(first).toMatchObject({ C1_pre: '3', C6_pre: '3', C1_post: '5', P1: '3', P1_label: '26-100', P2: '3', P2_label: '1-3 days a week' });
    expect(first).toMatchObject({ Q11: '5', Q13: '5', Q14: '5', Q12: '1', Q12_label: 'Yes' });
    expect(byCode[runs[3].code].score_raw).toBe('0');
    expect(byCode[runs[2].code].score_raw).toBe('4');
    for (const r of rows) {
      expect(r.arm_code).toBe(r.arm === 'experimental' ? '1' : '0');
      expect(r.arm).toBe(await armOf(db, r.participant_code));
      if (r.arm === 'control') expect([r.tokens_total, r.badges_earned, r.best_streak, r.level_reached, r.rank_shown]).toEqual(['', '', '', '', '']);
      else expect(r.rank_shown).not.toBe('');
      expect(r.started_at_utc).toMatch(/Z$/);
    }
  });

  it('long CSVs have one row per answer and per survey item', async () => {
    const { app, content } = await makeApp();
    await syntheticStudy(app, content);
    const questions = parseCsv(await exportCsv(app, 'questions'));
    expect(questions).toHaveLength(36);
    expect(Object.keys(questions[0]).slice(0, 8)).toEqual([
      'participant_code', 'arm', 'question_id', 'section', 'selected_option', 'is_correct', 'time_taken_ms', 'answered_at_utc',
    ]);
    expect(questions[0]).toMatchObject({ question_id: 'Q1', section: 'Sliding Window', response_status: 'answered' });
    const surveys = parseCsv(await exportCsv(app, 'surveys'));
    // 8 pre + 10 post per participant.
    expect(surveys).toHaveLength(4 * 18);
    expect(Object.keys(surveys[0]).slice(0, 6)).toEqual(['participant_code', 'arm', 'phase', 'item_id', 'value', 'value_label']);
    const first = surveys.filter((r) => r.participant_code === surveys[0].participant_code);
    expect(first.map((r) => `${r.phase}:${r.item_id}`)).toEqual([
      ...['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2'].map((id) => `pre:${id}`),
      ...['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'Q11', 'Q13', 'Q14', 'Q12'].map((id) => `post:${id}`),
    ]);
    expect(first.find((r) => r.item_id === 'P1')).toMatchObject({ value: '3', value_label: '26-100', measure: 'prior_experience' });
    expect(first.find((r) => r.item_id === 'C4')).toMatchObject({ reverse: '0', measure: 'confidence' });
  });

  it('allocation.csv includes the seed and every slot', async () => {
    const { app, content } = await makeApp();
    await syntheticStudy(app, content);
    const slots = parseCsv(await exportCsv(app, 'allocation'));
    expect(slots.length).toBeGreaterThanOrEqual(content.study.allocation.main_slots);
    expect(new Set(slots.map((s) => s.seed))).toEqual(new Set(['test-seed']));
    expect(slots.filter((s) => s.claimed === '1')).toHaveLength(4);
    const meta = parseCsv(await exportCsv(app, 'meta'));
    expect(meta.find((m) => m.key === 'allocation_seed').value).toBe('test-seed');
    expect(meta.find((m) => m.key === 'content_sha256:questions.json').value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the same synthetic run twice gives identical CSVs apart from timestamps', async () => {
    const a = await makeApp();
    const b = await makeApp();
    const runsA = await syntheticStudy(a.app, a.content);
    const runsB = await syntheticStudy(b.app, b.content);
    for (const name of ['participants', 'questions', 'surveys', 'gamification', 'allocation']) {
      const csvA = normalise(await exportCsv(a.app, name), runsA);
      const csvB = normalise(await exportCsv(b.app, name), runsB);
      // Durations and per-answer times are timing, not content.
      const dropTiming = (csv) => {
        const rows = parseCsv(csv);
        return rows.map((r) => ({ ...r, duration_s: undefined, time_taken_ms: undefined }));
      };
      expect(dropTiming(csvB), name).toEqual(dropTiming(csvA));
    }
  });

  it('pilot rows are excluded from every research export', async () => {
    const { app, db, content } = await makeApp();
    await request(app).post('/admin/api/mode').set('X-Admin-Token', ADMIN_TOKEN).send({ mode: 'pilot' }).expect(200);
    const pilotRun = await fullRun(app, content);
    await request(app).post('/admin/api/mode').set('X-Admin-Token', ADMIN_TOKEN).send({ mode: 'live' }).expect(200);
    const liveRun = await fullRun(app, content);
    expect((await db.get('SELECT COUNT(*) AS n FROM participants WHERE is_pilot = 1')).n).toBe(1);
    for (const name of ['participants', 'questions', 'surveys', 'events', 'gamification', 'allocation']) {
      const csv = await exportCsv(app, name);
      expect(csv, name).not.toContain(pilotRun.code);
    }
    expect(await exportCsv(app, 'participants')).toContain(liveRun.code);

    // The pilot can still be reviewed on its own.
    const pilotCsv = await request(app).get('/admin/api/export/participants.csv?cohort=pilot').set('X-Admin-Token', ADMIN_TOKEN);
    expect(pilotCsv.headers['content-disposition']).toMatch(/PILOT_participants\.csv/);
    const pilotRows = parseCsv(pilotCsv.text);
    expect(pilotRows.map((r) => r.participant_code)).toEqual([pilotRun.code]);
    expect(pilotRows[0].score_raw).toBe('9');
  });

  it('contains no name, email, IP or device field anywhere', async () => {
    const { app, db, content } = await makeApp();
    await syntheticStudy(app, content);
    const forbidden = /name|email|mail|ip_?addr|^ip$|user_?agent|device|phone|student_?id/i;
    const columns = await db.listColumns();
    expect(columns.length).toBeGreaterThan(40);
    // leaderboard_name is the random pseudonym ("Swift Otter"), not a person's name.
    expect(columns.filter((c) => forbidden.test(c.column_name) && c.column_name !== 'leaderboard_name')).toEqual([]);
    for (const name of ['participants', 'questions', 'surveys', 'events', 'gamification', 'allocation', 'meta']) {
      const header = (await exportCsv(app, name)).split('\n')[0].split(',');
      expect(header.filter((h) => forbidden.test(h)), name).toEqual([]);
      expect(await exportCsv(app, name)).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|::ffff:|@/);
    }
  });

  it('Q10 answers left in an early test database do not break the exports', async () => {
    const { app, db, content } = await makeApp();
    // 4 of 9 right (even positions).
    const run = await fullRun(app, content, { choose: (id, n) => (n % 2 ? wrongLetter(ANSWER_KEY[id]) : ANSWER_KEY[id]) });
    const { id } = await db.get('SELECT id FROM participants WHERE participant_code = ?', [run.code]);
    await db.run("INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES (?, 'post_a', 'Q10', 7, 'x')", [id]);
    const row = parseCsv(await exportCsv(app, 'participants')).find((r) => r.participant_code === run.code);
    expect(row).toMatchObject({ score_raw: '4', C1_post: '4' });
    expect(row).not.toHaveProperty('Q10');
    const surveys = parseCsv(await exportCsv(app, 'surveys')).filter((r) => r.participant_code === run.code);
    expect(surveys.at(-1)).toMatchObject({ phase: 'post_a', item_id: 'Q10', value: '7', measure: '' });
  });

  it('cutting Q13/Q14 removes their columns', async () => {
    const dir = contentCopy({
      'survey.json': (s) => {
        s.phases.post.sections[1].items = ['Q11', 'Q12'];
      },
    });
    const cut = await makeApp({ contentDir: dir });
    await fullRun(cut.app, cut.content);
    const columns = (await exportCsv(cut.app, 'participants')).split('\n')[0].split(',');
    expect(columns).not.toContain('Q13');
    expect(columns).not.toContain('Q14');
    expect(columns).toContain('Q12_label');
  });

  it('verify_exports.py reproduces the status counts from the CSVs', async () => {
    let python = null;
    for (const candidate of ['python3', 'python']) {
      try {
        execFileSync(candidate, ['--version'], { stdio: 'ignore' });
        python = candidate;
        break;
      } catch {
        // try the next one
      }
    }
    if (!python) return; // Python is optional; the R/Python check is documented in docs/.
    const { app, content } = await makeApp();
    await syntheticStudy(app, content);
    const abandoned = participant(app);
    await toQuestions(abandoned, content);
    await abandoned.post('/api/withdraw', { confirm: true });
    const dir = tmpDir('cq-export-');
    for (const [name, file] of [['participants', 'participants.csv'], ['questions', 'questions_long.csv'], ['surveys', 'surveys_long.csv']]) {
      fs.writeFileSync(path.join(dir, file), await exportCsv(app, name));
    }
    const status = (await request(app).get('/admin/api/status').set('X-Admin-Token', ADMIN_TOKEN)).body;
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
    const out = execFileSync(python, ['-I', path.join(ROOT, 'scripts', 'analysis', 'verify_exports.py'), dir, path.join(dir, 'status.json')], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/MATCH/);
  });
});
