import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { ROOT, loadConfig } from '../server/config.js';
import { bootstrap } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';
import { itemsForPhase } from '../server/services/surveyScoring.js';

export const ADMIN_TOKEN = 'test-admin-token-0123456789';
export const CONTENT_DIR = path.join(ROOT, 'server', 'content');
export const ANSWER_KEY = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'answer_key.json'), 'utf8'));
export const wrongLetter = (letter) => ({ A: 'B', B: 'C', C: 'D', D: 'A' })[letter];

export function tmpDir(prefix = 'cq-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A copy of the content folder with JSON edits applied: { 'study.json': (json) => { ... } }.
export function contentCopy(edits = {}) {
  const dir = tmpDir('cq-content-');
  fs.cpSync(CONTENT_DIR, dir, { recursive: true });
  for (const [file, edit] of Object.entries(edits)) {
    const full = path.join(dir, file);
    const json = JSON.parse(fs.readFileSync(full, 'utf8'));
    fs.writeFileSync(full, JSON.stringify(edit(json) ?? json, null, 2));
  }
  return dir;
}

// Tests run on SQLite by default. With TEST_DATABASE_URL set (a Postgres database) every test
// app gets its own empty schema there, so the same tests prove the cloud database path.
export const PG_URL = process.env.TEST_DATABASE_URL || '';
export const onPostgres = Boolean(PG_URL);
const openApps = new Set();

async function freshPgSchema() {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.end();
  return schema;
}

// A new empty database for a test that talks to the database layer directly.
export async function freshStore() {
  return onPostgres
    ? { databaseUrl: PG_URL, pgSchema: await freshPgSchema(), pgPoolMax: 4 }
    : { dbPath: path.join(tmpDir(), 'direct.sqlite') };
}

// `store` reuses an existing database between two apps (a server restart): { dbPath } or { pgSchema }.
export async function makeApp({ contentDir, env = {}, store } = {}) {
  const storeEnv = onPostgres
    ? { DATABASE_URL: PG_URL, PG_SCHEMA: store?.pgSchema ?? (await freshPgSchema()), PG_POOL_MAX: '4' }
    : { DB_PATH: store?.dbPath ?? path.join(tmpDir(), 'test.sqlite') };
  const config = loadConfig({
    ...storeEnv,
    ADMIN_TOKEN,
    ALLOCATION_SEED: 'test-seed',
    BACKUP_DIR: path.join(tmpDir(), 'backups'),
    ...(contentDir ? { CONTENT_DIR: contentDir } : {}),
    ...env,
  });
  const { db, content } = await bootstrap(config);
  const { app, study } = createApp({ db, content, config });
  // Test-only link so fullRun can read each run's arm straight from the database.
  app.cqTestDb = db;
  const ctx = { app, db, content, config, study, store: { dbPath: config.dbPath, pgSchema: config.pgSchema } };
  openApps.add(ctx);
  return ctx;
}

export async function closeApp(ctx) {
  if (!openApps.delete(ctx)) return;
  await ctx.db.close();
}

export async function closeAllApps() {
  await Promise.all([...openApps].map(closeApp));
}

// Supertest agent (keeps the cookie, like one browser) that records every response.
export function participant(app) {
  const agent = request.agent(app);
  const log = [];
  const record = (res) => {
    log.push({ status: res.status, body: res.body, text: res.text });
    return res;
  };
  return {
    agent,
    log,
    get: (url) => agent.get(url).then(record),
    post: (url, body = {}) => agent.post(url).send(body).then(record),
  };
}

// Answers for every item in a survey: scale items get `value` (clamped to the scale, default the
// middle), choice items get the option with that value if there is one, else the first option.
export function surveyAnswers(content, phase, value) {
  const answers = {};
  for (const item of itemsForPhase(content.survey, phase)) {
    if (item.type === 'choice') {
      answers[item.id] = (item.options.find((o) => o.value === value) ?? item.options[0]).value;
    } else {
      const { min, max } = item.scale;
      answers[item.id] = Math.min(max, Math.max(min, value ?? Math.ceil((min + max) / 2)));
    }
  }
  return answers;
}

let keyCounter = 0;
export const key = () => `test-key-${Date.now()}-${keyCounter++}`;

export async function consent(p) {
  const res = await p.post('/api/session', { consent: true });
  if (res.status !== 201) throw new Error(`session failed: ${res.status} ${res.text}`);
  return res;
}

export async function toQuestions(p, content, preValue) {
  await consent(p);
  const pre = await p.post('/api/survey/pre', { answers: surveyAnswers(content, 'pre', preValue), idempotencyKey: key() });
  if (pre.status !== 200) throw new Error(`pre survey failed: ${pre.status} ${pre.text}`);
  const ack = await p.post('/api/instructions/ack');
  if (ack.status !== 200) throw new Error(`instructions failed: ${ack.status} ${ack.text}`);
}

// choose(questionId, n) -> letter. Defaults to the correct answer.
export async function answerAll(p, content, choose = (id) => ANSWER_KEY[id]) {
  const results = [];
  for (let n = 1; n <= content.questions.length; n++) {
    const q = await p.get(`/api/question/${n}`);
    if (q.status !== 200) throw new Error(`question ${n} failed: ${q.status} ${q.text}`);
    const a = await p.post('/api/answer', { questionId: q.body.id, selectedOption: choose(q.body.id, n), idempotencyKey: key() });
    if (a.status !== 200) throw new Error(`answer ${n} failed: ${a.status} ${a.text}`);
    results.push(a.body);
    const next = await p.post('/api/next', { n });
    if (next.status !== 200) throw new Error(`next ${n} failed: ${next.status} ${next.text}`);
  }
  return results;
}

// After Q9: the score reveal, then the post-test.
export async function finish(p, content, postValue) {
  const results = await p.get('/api/results');
  if (results.status !== 200) throw new Error(`results failed: ${results.status} ${results.text}`);
  await p.post('/api/results/ack');
  const post = await p.post('/api/survey/post', { answers: surveyAnswers(content, 'post', postValue), idempotencyKey: key() });
  if (post.status !== 200) throw new Error(`post survey failed: ${post.status} ${post.text}`);
  const done = await p.post('/api/complete');
  if (done.status !== 200) throw new Error(`complete failed: ${done.status} ${done.text}`);
  return { results: results.body, debrief: done.body };
}

export async function fullRun(app, content, { choose, preValue, postValue } = {}) {
  const p = participant(app);
  await toQuestions(p, content, preValue);
  const answers = await answerAll(p, content, choose);
  const { results, debrief } = await finish(p, content, postValue);
  const code = debrief.participant_code;
  // The arm comes from the database, never from what the API said.
  const arm = app.cqTestDb ? await armOf(app.cqTestDb, code) : undefined;
  return { p, answers, results, debrief, code, arm };
}

export const armOf = async (db, code) => (await db.get('SELECT arm FROM participants WHERE participant_code = ?', [code]))?.arm;

export async function armMap(db) {
  return new Map((await db.all('SELECT participant_code, arm FROM participants')).map((r) => [r.participant_code, r.arm]));
}

export const count = async (db, sql, params = []) => (await db.get(sql, params)).n;

// Every key that appears anywhere in a JSON value.
export function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}
