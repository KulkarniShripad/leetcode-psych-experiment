// Screenshots of the experimental group in a busy session (live rank, full leaderboard).
// Runs only with SCREENSHOTS=1 (npm run screenshots).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, request as playwrightRequest, test } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const answerKey = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'content', 'answer_key.json'), 'utf8'));
const wrong = (letter) => ({ A: 'B', B: 'C', C: 'D', D: 'A' })[letter];
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
let keyN = 0;
const key = () => `shot-${Date.now()}-${keyN++}`;

test.skip(!process.env.SCREENSHOTS, 'screenshots only');

// A participant played entirely through the API: the first `correct` questions right, the rest wrong.
async function apiPlayer(baseURL, correct) {
  const api = await playwrightRequest.newContext({ baseURL });
  await api.post('/api/session', { data: { consent: true } });
  const survey = await (await api.get('/api/survey/pre')).json();
  await api.post('/api/survey/pre', { data: { answers: Object.fromEntries(survey.items.map((i) => [i.id, 4])) } });
  await api.post('/api/instructions/ack', { data: {} });
  for (let n = 1; n <= 9; n++) {
    const q = await (await api.get(`/api/question/${n}`)).json();
    const letter = n <= correct ? answerKey[q.id] : wrong(answerKey[q.id]);
    await api.post('/api/answer', { data: { questionId: q.id, selectedOption: letter, idempotencyKey: key() } });
    await api.post('/api/next', { data: { n } });
  }
  await api.get('/api/results');
  await api.dispose();
}

test('experimental group in a busy session', async ({ browser, baseURL }) => {
  for (const correct of [9, 7, 5, 3, 8, 6, 4, 2]) await apiPlayer(baseURL, correct);

  // Join until this browser lands in the experimental group (it has the game bar).
  let page;
  for (let attempt = 0; attempt < 6; attempt++) {
    page = await (await browser.newContext()).newPage();
    await page.goto('/');
    await page.getByLabel(/I agree to take part/).check();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const sets = page.locator('fieldset.likert');
    await expect(sets.first()).toBeVisible();
    for (let i = 0; i < (await sets.count()); i++) await sets.nth(i).locator('input[type=radio]').nth(4).check();
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.getByRole('button', { name: 'Start question 1' }).click();
    await expect(page.getByRole('heading', { name: 'Question 1 of 9' })).toBeVisible();
    if (await page.getByTestId('hud').count()) break;
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Stop taking part' }).click();
  }
  await expect(page.getByTestId('hud')).toBeVisible();

  for (let n = 1; n <= 9; n++) {
    await expect(page.getByRole('heading', { name: `Question ${n} of 9` })).toBeVisible();
    const id = `Q${n}`;
    await page.locator(`input[name=answer][value=${n === 5 ? wrong(answerKey[id]) : answerKey[id]}]`).check();
    await page.getByRole('button', { name: 'Submit answer' }).click();
    await expect(page.getByTestId('fx-next')).toBeVisible();
    if (n === 4) {
      await expect(page.getByTestId('fx-rank')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, '08-overlay-live-rank.png') });
    }
    await page.getByTestId('fx-next').click();
  }
  await expect(page.getByTestId('leaderboard')).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SHOTS, '09-final-leaderboard.png'), fullPage: true });
});
