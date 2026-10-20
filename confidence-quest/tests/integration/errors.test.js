import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../server/config.js';
import { getMeta } from '../../server/db/connection.js';
import { SCHEMA_VERSION } from '../../server/db/migrate.js';
import {
  ANSWER_KEY, answerAll, closeAllApps, closeApp, contentCopy, finish, key, makeApp, onPostgres, participant, tmpDir, toQuestions,
} from '../helpers.js';

const startServer = (env) =>
  spawnSync(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, DB_PATH: path.join(tmpDir(), 'x.sqlite'), PORT: '0', ...env },
    encoding: 'utf8',
    timeout: 10000,
  });

describe('startup', () => {
  it('refuses to start when a content file is missing, naming the file', () => {
    const dir = contentCopy();
    fs.rmSync(path.join(dir, 'survey.json'));
    const run = startServer({ CONTENT_DIR: dir });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Refusing to start/);
    expect(run.stderr).toMatch(/survey\.json: file is missing/);
  });

  it('refuses to start when a field is invalid, naming the file and field', () => {
    const dir = contentCopy({
      'questions.json': (q) => {
        q.questions[2].options[0].key = 'X';
      },
    });
    const run = startServer({ CONTENT_DIR: dir });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/questions\.json: questions\.2\.options\.0\.key/);
  });

  it('refuses to start in production without an admin token', () => {
    const run = startServer({ NODE_ENV: 'production', ADMIN_TOKEN: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/ADMIN_TOKEN/);
  });

  it('builds the database from the schema when it is empty', async () => {
    const { db } = await makeApp();
    const tables = [...new Set((await db.listColumns()).map((c) => c.table_name))].sort();
    expect(tables).toEqual(['allocation_slots', 'events', 'gamification_events', 'meta', 'participants', 'question_responses', 'survey_responses']);
    expect(await getMeta(db, 'schema_version')).toBe(SCHEMA_VERSION);
    if (db.dialect === 'sqlite') expect(db.raw.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it.skipIf(onPostgres)('upgrades a version 1 SQLite database without losing answers', async () => {
    const { store } = await makeApp();
    await closeAllApps();
    // Put the database back into its v1 shape (two survey phases only) with one answer in it.
    const raw = new Database(store.dbPath);
    raw.exec(`
      CREATE TABLE sr_v1 (id INTEGER PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id),
        phase TEXT NOT NULL CHECK (phase IN ('pre', 'post')), item_id TEXT NOT NULL, value INTEGER NOT NULL,
        submitted_at TEXT NOT NULL, UNIQUE (participant_id, phase, item_id));
      DROP TABLE survey_responses; ALTER TABLE sr_v1 RENAME TO survey_responses;
      INSERT INTO participants (id, participant_code, token_hash, consent_at, consent_version, current_step, started_at)
        VALUES ('p1', 'ACDEFH', 'h', 'x', 'v', 'PRE_SURVEY', 'x');
      INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES ('p1', 'pre', 'C1', 5, 'x');
      UPDATE meta SET value = '1' WHERE key = 'schema_version';`);
    raw.close();
    const { db } = await makeApp({ store });
    expect(await getMeta(db, 'schema_version')).toBe(SCHEMA_VERSION);
    expect(await db.all('SELECT phase, item_id, value FROM survey_responses')).toEqual([{ phase: 'pre', item_id: 'C1', value: 5 }]);
    await db.run("INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES ('p1', 'post_a', 'Q10', 6, 'x')");
  });

  it('logs a content change between starts', async () => {
    const first = await makeApp();
    await closeApp(first);
    const dir = contentCopy({
      'study.json': (s) => {
        s.instructions.title = 'Read this first';
      },
    });
    const { db } = await makeApp({ store: first.store, contentDir: dir });
    const event = (await db.get("SELECT payload FROM events WHERE event_type = 'content_changed'"));
    expect(JSON.parse(event.payload)).toEqual({ files: ['study.json'] });
  });
});

describe('database rules', () => {
  it('unique constraints reject duplicate answers and duplicate survey rows', async () => {
    const { app, db } = await makeApp();
    const p = participant(app);
    await p.post('/api/session', { consent: true });
    const id = (await db.get('SELECT id FROM participants')).id;
    const now = new Date().toISOString();
    const unique = /UNIQUE|unique constraint/i;
    await db.run("INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES (?, 'pre', 'C1', 3, ?)", [id, now]);
    await expect(
      db.run("INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES (?, 'pre', 'C1', 4, ?)", [id, now]),
    ).rejects.toThrow(unique);
    await db.run("INSERT INTO question_responses (participant_id, question_id, position, shown_at) VALUES (?, 'Q1', 1, ?)", [id, now]);
    await expect(
      db.run("INSERT INTO question_responses (participant_id, question_id, position, shown_at) VALUES (?, 'Q1', 1, ?)", [id, now]),
    ).rejects.toThrow(unique);
    // Part A answers have their own phase.
    await db.run("INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES (?, 'post_a', 'Q10', 6, ?)", [id, now]);
    await expect(
      db.run("INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES (?, 'later', 'Q10', 6, ?)", [id, now]),
    ).rejects.toThrow(/CHECK|check constraint/i);
  });

  it('the events table is append-only', async () => {
    const { app, db } = await makeApp();
    await participant(app).post('/api/session', { consent: true });
    await expect(db.run("UPDATE events SET event_type = 'x'")).rejects.toThrow(/append-only/);
  });
});

describe('time limit (D10, off by default)', () => {
  it('closes the test at the deadline: unanswered questions count as wrong', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.questions.time_limit = { enabled: true, total_seconds: 60, on_expiry: 'end_test' };
      },
    });
    const { app, db, content } = await makeApp({ contentDir: dir });
    const p = participant(app);
    await toQuestions(p, content);
    const q1 = await p.get('/api/question/1');
    expect(q1.body.time_remaining_s).toBeGreaterThan(55);
    await p.post('/api/answer', { questionId: 'Q1', selectedOption: ANSWER_KEY.Q1, idempotencyKey: key() });
    await p.post('/api/next', { n: 1 });
    await p.get('/api/question/2');

    // Move the start back two minutes, as if time ran out.
    await db.run('UPDATE participants SET questions_started_at = ?', [new Date(Date.now() - 120000).toISOString()]);
    const state = await p.get('/api/state');
    // Time is up: on to Part A (Q10), then the score.
    expect(state.body.step).toBe('POST_SURVEY_A');
    const late = await p.post('/api/answer', { questionId: 'Q2', selectedOption: ANSWER_KEY.Q2, idempotencyKey: key() });
    expect(late.body).toMatchObject({ correct: false, expired: true });

    const rows = (await db.all('SELECT question_id, selected_option, is_correct, expired FROM question_responses ORDER BY position'));
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({ question_id: 'Q1', selected_option: 'D', is_correct: 1, expired: 0 });
    expect(rows.slice(1).every((r) => r.expired === 1 && r.is_correct === 0 && r.selected_option === null)).toBe(true);
    const { results } = await finish(p, content);
    expect(results.score.correct).toBe(1);
  });

  it('does not touch a participant who already answered all nine', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.questions.time_limit = { enabled: true, total_seconds: 60, on_expiry: 'end_test' };
      },
    });
    const { app, db, content } = await makeApp({ contentDir: dir });
    const p = participant(app);
    await toQuestions(p, content);
    for (let n = 1; n <= 9; n++) {
      const q = await p.get(`/api/question/${n}`);
      await p.post('/api/answer', { questionId: q.body.id, selectedOption: ANSWER_KEY[q.body.id], idempotencyKey: key() });
      if (n < 9) await p.post('/api/next', { n });
    }
    const finishedAt = (await db.get('SELECT questions_finished_at FROM participants')).questions_finished_at;
    await db.run('UPDATE participants SET questions_started_at = ?', [new Date(Date.now() - 120000).toISOString()]);
    expect((await p.get('/api/state')).body).toMatchObject({ step: 'FEEDBACK', n: 9 });
    expect((await db.get('SELECT questions_finished_at FROM participants')).questions_finished_at).toBe(finishedAt);
    expect((await db.get("SELECT COUNT(*) AS n FROM events WHERE event_type = 'time_expired'")).n).toBe(0);
  });
});

describe('survey content', () => {
  it('renders entirely from survey.json: editing the file changes the survey', async () => {
    const dir = contentCopy({
      'survey.json': (s) => {
        s.items.find((i) => i.id === 'C1').text = 'Solve coding problems that involve hash maps';
        s.scales.confidence_7 = { min: 1, max: 5, labels: { 1: 'Not at all', 5: 'Completely' } };
        s.items.push({ id: 'P3', measure: 'other', type: 'choice', text: 'Is this your first study?', options: [{ value: 1, label: 'Yes' }, { value: 2, label: 'No' }] });
        s.phases.pre.sections[1].items.push('P3');
      },
    });
    const { app } = await makeApp({ contentDir: dir });
    const p = participant(app);
    await p.post('/api/session', { consent: true });
    const survey = (await p.get('/api/survey/pre')).body;
    expect(survey.sections[0].items[0]).toEqual({
      id: 'C1',
      text: 'Solve coding problems that involve hash maps',
      type: 'scale',
      scale: { min: 1, max: 5, labels: { 1: 'Not at all', 5: 'Completely' } },
    });
    expect(survey.sections[1].items.map((i) => i.id)).toEqual(['P1', 'P2', 'P3']);
    const ids = survey.sections.flatMap((s) => s.items.map((i) => i.id));
    const tooHigh = await p.post('/api/survey/pre', { answers: { ...Object.fromEntries(ids.map((id) => [id, 1])), C2: 6 } });
    expect(tooHigh.body.error.message).toMatch(/1 to 5/);
  });

  it('cutting Q13 and Q14 (if time is tight) is a content edit only', async () => {
    const dir = contentCopy({
      'survey.json': (s) => {
        s.phases.post.sections[1].items = ['Q11', 'Q12'];
      },
    });
    const { app, content } = await makeApp({ contentDir: dir });
    const p = participant(app);
    await toQuestions(p, content);
    await answerAll(p, content);
    await finish(p, content);
    expect(content.warnings.join(' ')).toMatch(/not asked in any survey: Q13, Q14/);
  });
});

describe("'I don't know' option (D3, off by default)", () => {
  it('is offered and stored as IDK, scored incorrect', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.questions.dont_know_option.enabled = true;
      },
    });
    const { app, db, content } = await makeApp({ contentDir: dir });
    const p = participant(app);
    await toQuestions(p, content);
    const q = await p.get('/api/question/1');
    expect(q.body.dont_know).toEqual({ key: 'IDK', label: "I don't know" });
    const res = await p.post('/api/answer', { questionId: 'Q1', selectedOption: 'IDK', idempotencyKey: key() });
    expect(res.body.correct).toBe(false);
    expect((await db.get('SELECT selected_option, is_correct FROM question_responses'))).toEqual({ selected_option: 'IDK', is_correct: 0 });
  });
});

describe('random question order (D12, fixed by default)', () => {
  it('serves each participant all nine questions once, in their stored order', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.questions.order = 'random_per_participant';
      },
    });
    const { app, db, content } = await makeApp({ contentDir: dir });
    const p = participant(app);
    await toQuestions(p, content);
    await answerAll(p, content);
    const order = JSON.parse((await db.get('SELECT question_order FROM participants')).question_order);
    const served = p.log.filter((e) => e.body?.options && e.body?.id).map((e) => e.body.id);
    expect(served).toEqual(order);
    expect([...order].sort()).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9']);
  });
});

describe('allocation list running out', () => {
  it('extends the list by a whole new block instead of failing', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.allocation.main_slots = 2;
      },
    });
    const { app, db, content } = await makeApp({ contentDir: dir });
    for (let i = 0; i < 5; i++) await toQuestions(participant(app), content);
    expect((await db.get("SELECT COUNT(*) AS n FROM allocation_slots WHERE list = 'main'")).n).toBe(6);
    expect((await db.get("SELECT COUNT(*) AS n FROM events WHERE event_type = 'allocation_extended'")).n).toBe(2);
  });
});

describe('static client', () => {
  it('every screen module referenced by app.js exists', () => {
    const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    for (const [, file] of app.matchAll(/from '\.\/(screens\/\w+\.js)'/g)) {
      expect(fs.existsSync(path.join(ROOT, 'public', 'js', file)), file).toBe(true);
    }
  });

  it('serves security headers and no-store on the API', async () => {
    const { app } = await makeApp();
    const res = await request(app).get('/api/texts');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
