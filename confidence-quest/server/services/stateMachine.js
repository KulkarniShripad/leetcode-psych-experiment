import crypto from 'node:crypto';
import { getMeta } from '../db/connection.js';
import { AppError } from '../middleware/errors.js';
import { nowIso, randomCode, randomToken, sha256, fillTemplate } from '../util.js';
import { claimSlot, listFor } from './assignment.js';
import { allowedOptions, isCorrect, scoreRaw } from './scoring.js';
import { hasPhase, publicSurvey, validateSurveySubmission } from './surveyScoring.js';
import * as game from './gamification.js';

// S0 consent happens before a participant row exists, so it is not a stored step.
// After Q9: POST_SURVEY_A (Q10, before any score) -> FINAL (score reveal) -> POST_SURVEY (Part B).
export const STEPS = ['PRE_SURVEY', 'INSTRUCTIONS', 'QUESTION', 'FEEDBACK', 'POST_SURVEY_A', 'FINAL', 'POST_SURVEY', 'DEBRIEF'];
const STAGE = { PRE_SURVEY: 1, INSTRUCTIONS: 2, QUESTION: 3, FEEDBACK: 3, POST_SURVEY_A: 4, FINAL: 5, POST_SURVEY: 6, DEBRIEF: 7 };
const PHASE_STEP = { pre: 'PRE_SURVEY', post_a: 'POST_SURVEY_A', post: 'POST_SURVEY' };

const notYourTurn = (message = 'That step is not available right now.') => new AppError('NOT_YOUR_TURN', message);

const SQL = {
  closedResponses:
    'SELECT * FROM question_responses WHERE participant_id = ? AND (answered_at IS NOT NULL OR expired = 1) ORDER BY position',
  response: 'SELECT * FROM question_responses WHERE participant_id = ? AND question_id = ?',
  markShown:
    'INSERT INTO question_responses (participant_id, question_id, position, shown_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  insertGameEvent: 'INSERT INTO gamification_events (participant_id, type, key, value, created_at) VALUES (?, ?, ?, ?, ?)',
  insertEvent: 'INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
};

export function createStudy({ db, content }) {
  const { study, survey, gamification: gam, questions, questionsById, answerKey } = content;
  const totalQuestions = questions.length;
  // Where participants go after the ninth question.
  const afterQuestions = hasPhase(survey, 'post_a') ? 'POST_SURVEY_A' : 'FINAL';

  const participantById = (id, lock = false) =>
    db.get(`SELECT * FROM participants WHERE id = ?${lock ? db.forUpdate : ''}`, [id]);
  const closedResponses = (id) => db.all(SQL.closedResponses, [id]);
  const gameEvent = (id, type, key, value, at) => db.run(SQL.insertGameEvent, [id, type, key, value, at]);

  async function update(id, fields) {
    const keys = Object.keys(fields);
    await db.run(`UPDATE participants SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
  }

  async function logEvent(participantId, type, payload = null) {
    await db.run(SQL.insertEvent, [participantId, type, payload === null ? null : JSON.stringify(payload), nowIso()]);
  }

  const orderOf = (p) => JSON.parse(p.question_order);
  const isActive = (p) => p.status === 'in_progress' || p.status === 'completed';

  function assertActive(p) {
    if (!isActive(p)) throw new AppError('FORBIDDEN', 'You have stopped taking part, so this is no longer available.');
  }

  // Runs `fn` in a transaction on a freshly read participant row, locked against concurrent
  // requests from the same participant (double clicks, retries, a second tab).
  const tx = (p, fn) => db.transaction(async () => fn(await participantById(p.id, true)));

  // ---------- time limit (D10) ----------

  function deadlineOf(p) {
    const limit = study.questions.time_limit;
    if (!limit.enabled || !p.questions_started_at) return null;
    return new Date(Date.parse(p.questions_started_at) + limit.total_seconds * 1000);
  }

  const inQuestions = (p) => p.current_step === 'QUESTION' || p.current_step === 'FEEDBACK';

  // Closes the test when the time limit has passed: unanswered questions are stored as
  // expired (no answer, incorrect) and the participant moves on.
  async function applyExpiry(p) {
    if (!isActive(p) || !inQuestions(p) || p.questions_finished_at) return p;
    const deadline = deadlineOf(p);
    if (!deadline || Date.now() < deadline.getTime()) return p;
    return tx(p, async (cur) => {
      if (!inQuestions(cur) || cur.questions_finished_at) return cur;
      const shownAt = deadline.toISOString();
      for (const [i, qid] of orderOf(cur).entries()) {
        await db.run(SQL.markShown, [cur.id, qid, i + 1, shownAt]);
        await db.run(
          'UPDATE question_responses SET expired = 1, is_correct = 0 WHERE participant_id = ? AND question_id = ? AND answered_at IS NULL',
          [cur.id, qid],
        );
      }
      await update(cur.id, { current_step: afterQuestions, current_question: null, questions_finished_at: shownAt });
      await logEvent(cur.id, 'time_expired', { at_position: cur.current_question });
      return participantById(cur.id);
    });
  }

  function timer(p) {
    const deadline = deadlineOf(p);
    if (!deadline) return {};
    return {
      deadline_at: deadline.toISOString(),
      time_remaining_s: Math.max(0, Math.round((deadline.getTime() - Date.now()) / 1000)),
    };
  }

  // ---------- S0: consent / session ----------

  async function createParticipant() {
    const token = randomToken();
    const id = crypto.randomUUID();
    await db.transaction(async () => {
      const isPilot = (await getMeta(db, 'study_mode')) === 'pilot' ? 1 : 0;
      let code;
      do code = randomCode();
      while (await db.get('SELECT 1 AS x FROM participants WHERE participant_code = ?', [code]));
      const now = nowIso();
      await db.run(
        `INSERT INTO participants (id, participant_code, token_hash, is_pilot, consent_at, consent_version, current_step, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'PRE_SURVEY', ?, 'in_progress')`,
        [id, code, sha256(token), isPilot, now, study.consent.version, now],
      );
      await logEvent(id, 'consent_given', { consent_version: study.consent.version });
    });
    return { token, participant: await participantById(id) };
  }

  // ---------- state ----------

  function instructionsFor(p) {
    const paragraphs = [...study.instructions.paragraphs];
    // D4: the experimental arm may get one extra line explaining the game features.
    if (p.arm === 'experimental' && gam.instructions_extra && game.anyGameFeature(gam)) paragraphs.push(gam.instructions_extra);
    return { title: study.instructions.title, paragraphs, start_button: study.instructions.start_button };
  }

  // The current step and question number. Never includes the arm label.
  async function publicState(participant) {
    const p = await applyExpiry(await participantById(participant.id));
    if (!isActive(p)) {
      return { step: 'WITHDRAWN', withdrawn: { title: study.withdraw.title, paragraphs: study.withdraw.paragraphs } };
    }
    const state = { step: p.current_step, total_questions: totalQuestions };
    if (p.current_step === 'INSTRUCTIONS') state.instructions = instructionsFor(p);
    if (inQuestions(p)) {
      state.n = p.current_question;
      Object.assign(state, timer(p));
    }
    if (p.current_step === 'FEEDBACK') state.feedback = await storedResult(p, orderOf(p)[p.current_question - 1]);
    return state;
  }

  // ---------- surveys: S1 (pre), Part A (post_a), Part B (post) ----------

  function assertPhaseStep(p, phase) {
    if (!hasPhase(survey, phase) || p.current_step !== PHASE_STEP[phase]) throw notYourTurn();
  }

  async function getSurvey(participant, phase) {
    const p = await participantById(participant.id);
    assertActive(p);
    assertPhaseStep(p, phase);
    return {
      ...publicSurvey(survey, phase),
      submit_button: study.surveys.submit_button,
      missing_message: study.surveys.missing_message,
    };
  }

  async function submitSurvey(participant, phase, answers) {
    return tx(participant, async (p) => {
      assertActive(p);
      // A repeat submit (double click, retry) is ignored.
      const already = await db.get('SELECT COUNT(*) AS n FROM survey_responses WHERE participant_id = ? AND phase = ?', [p.id, phase]);
      if (already.n > 0) return { already_submitted: true };
      assertPhaseStep(p, phase);
      const rows = validateSurveySubmission(survey, phase, answers, study.surveys.missing_message);
      const now = nowIso();
      for (const row of rows) {
        await db.run('INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES (?, ?, ?, ?, ?)', [
          p.id,
          phase,
          row.item_id,
          row.value,
          now,
        ]);
      }
      await logEvent(p.id, 'survey_submitted', { phase, items: rows.length });
      if (phase === 'pre') await assignArm(p, now);
      else if (phase === 'post_a') await update(p.id, { current_step: 'FINAL' });
      else {
        await update(p.id, { current_step: 'DEBRIEF', status: 'completed', completed_at: now });
        await logEvent(p.id, 'completed');
      }
      return { already_submitted: false };
    });
  }

  // Random assignment happens when the pre-survey is submitted (Level 4).
  async function assignArm(p, now) {
    const slot = await claimSlot(db, p.id, listFor(p.is_pilot === 1, study.allocation));
    const order = questions.map((q) => q.id);
    if (study.questions.order === 'random_per_participant') {
      for (let i = order.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    const fields = {
      arm: slot.arm,
      allocation_slot_id: slot.id,
      assigned_at: now,
      current_step: 'INSTRUCTIONS',
      question_order: JSON.stringify(order),
    };
    if (slot.arm === 'experimental') {
      const taken = new Set(
        (await db.all('SELECT leaderboard_name FROM participants WHERE leaderboard_name IS NOT NULL')).map((r) => r.leaderboard_name),
      );
      fields.leaderboard_name = game.pickLeaderboardName(gam, (name) => taken.has(name));
    }
    await update(p.id, fields);
    await logEvent(p.id, 'arm_assigned', { slot_id: slot.id, seq_no: slot.seq_no });
  }

  // ---------- S2: instructions ----------

  async function ackInstructions(participant) {
    return tx(participant, async (p) => {
      assertActive(p);
      if (STAGE[p.current_step] > STAGE.INSTRUCTIONS) return; // repeat click
      if (p.current_step !== 'INSTRUCTIONS') throw notYourTurn();
      await update(p.id, { current_step: 'QUESTION', current_question: 1, questions_started_at: nowIso() });
      await logEvent(p.id, 'instructions_ack');
    });
  }

  // ---------- S3 / S4: questions and feedback ----------

  async function getQuestion(participant, n) {
    return tx(participant, async (p) => {
      assertActive(p);
      if (p.current_step !== 'QUESTION' || p.current_question !== n) {
        throw notYourTurn('You can only open the question you are currently on.');
      }
      const qid = orderOf(p)[n - 1];
      // shown_at is set the first time only, so a refresh does not reset the clock.
      const inserted = (await db.run(SQL.markShown, [p.id, qid, n, nowIso()])).changes === 1;
      if (inserted) await logEvent(p.id, 'question_shown', { n, question_id: qid });
      const q = questionsById[qid];
      const out = {
        n,
        total: totalQuestions,
        id: q.id,
        prompt: q.prompt,
        options_format: q.options_format,
        options: q.options.map((o) => ({ key: o.key, text: o.text })),
        submit_button: study.questions.submit_button,
        progress_text: fillTemplate(study.questions.progress_text, { n, total: totalQuestions }),
        ...timer(p),
      };
      if (study.questions.show_section) out.section = q.section;
      if (study.questions.show_difficulty_labels) out.difficulty_label = q.difficulty_label;
      if (q.code !== undefined) {
        out.code = q.code;
        out.language = q.language ?? null;
      }
      if (q.note) out.note = q.note;
      if (study.questions.dont_know_option.enabled) out.dont_know = { key: 'IDK', label: study.questions.dont_know_option.label };
      // The always-visible game bar (experimental only).
      if (p.arm === 'experimental' && gam.hud.enabled) {
        const state = game.computeGameState(gam, questions, await closedResponses(p.id));
        out.game = { hud: game.hudState(gam, state, totalQuestions) };
      }
      return out;
    });
  }

  // Where the Next button on this question's feedback leads. For an old question
  // (a late repeat) it is simply wherever the participant is now.
  function nextAfter(p, position) {
    if (p.current_step === 'FEEDBACK' && p.current_question === position) {
      return position < totalQuestions ? { step: 'QUESTION', n: position + 1 } : { step: afterQuestions };
    }
    return p.current_question ? { step: p.current_step, n: p.current_question } : { step: p.current_step };
  }

  async function gameForPosition(p, position) {
    const responses = (await closedResponses(p.id)).filter((r) => r.position <= position);
    const questionId = orderOf(p)[position - 1];
    // Replay the live rank exactly as it was shown when the answer came in.
    const shown = await db.all(
      "SELECT type, value FROM gamification_events WHERE participant_id = ? AND key = ? AND type IN ('live_rank', 'live_rank_pool')",
      [p.id, questionId],
    );
    const recorded = Object.fromEntries(shown.map((e) => [e.type, e.value]));
    const liveRank = 'live_rank' in recorded ? { ahead: recorded.live_rank, of: recorded.live_rank_pool } : null;
    return game.feedbackGame(gam, game.computeGameState(gam, questions, responses), position, { liveRank, totalQuestions });
  }

  // The reply to an answer, rebuilt from the stored row so repeats return the same thing.
  async function storedResult(p, questionId) {
    const row = await db.get(SQL.response, [p.id, questionId]);
    if (!row || (row.answered_at === null && row.expired === 0)) return null;
    const result = {
      n: row.position,
      correct: row.is_correct === 1,
      expired: row.expired === 1,
      next: nextAfter(p, row.position),
      next_button: row.position < totalQuestions ? study.feedback.next_button : study.feedback.last_button,
      text: row.is_correct === 1 ? study.feedback.correct_text : study.feedback.incorrect_text,
    };
    if (p.arm === 'experimental') result.game = await gameForPosition(p, row.position);
    return result;
  }

  async function submitAnswer(participant, { questionId, selectedOption, idempotencyKey }) {
    const fresh = await applyExpiry(participant);
    return tx(fresh, async (p) => {
      assertActive(p);
      if (!questionsById[questionId]) throw new AppError('VALIDATION', 'Unknown question.');
      // Second submit for the same question: ignore it and return the stored result.
      const stored = await storedResult(p, questionId);
      if (stored) return stored;
      const order = orderOf(p);
      if (p.current_step !== 'QUESTION' || order[p.current_question - 1] !== questionId) {
        throw notYourTurn('That is not the question you are on.');
      }
      if (!allowedOptions(study).includes(selectedOption)) throw new AppError('VALIDATION', 'Please choose one of the options.');
      const row = await db.get(SQL.response, [p.id, questionId]);
      if (!row) throw notYourTurn('Please open the question before answering it.');

      const now = new Date();
      const correct = isCorrect(answerKey, questionId, selectedOption) ? 1 : 0;
      const taken = Math.max(0, now.getTime() - Date.parse(row.shown_at));
      await db.run(
        `UPDATE question_responses SET selected_option = ?, is_correct = ?, answered_at = ?, time_taken_ms = ?, idempotency_key = ?
         WHERE participant_id = ? AND question_id = ? AND answered_at IS NULL AND expired = 0`,
        [selectedOption, correct, now.toISOString(), taken, idempotencyKey, p.id, questionId],
      );
      const position = p.current_question;
      const fields = { current_step: 'FEEDBACK' };
      if (position === totalQuestions) fields.questions_finished_at = now.toISOString();
      await update(p.id, fields);
      await logEvent(p.id, 'answer_submitted', { n: position, question_id: questionId });

      if (p.arm === 'experimental') await recordGameEvents(p, questionId, position, now.toISOString());
      return storedResult(await participantById(p.id), questionId);
    });
  }

  // What the experimental participant earned on this answer, written as it happens.
  async function recordGameEvents(p, questionId, position, at) {
    const state = game.computeGameState(gam, questions, await closedResponses(p.id));
    const step = state.steps.find((s) => s.position === position);
    if (step.tokens > 0) await gameEvent(p.id, 'tokens', questionId, step.tokens, at);
    if (step.streak_bonus > 0) await gameEvent(p.id, 'streak_bonus', questionId, step.streak_bonus, at);
    for (const key of step.new_badges) await gameEvent(p.id, 'badge', key, 1, at);
    if (step.leveled_up) await gameEvent(p.id, 'level_up', gam.levels.list[step.level_index].name, step.level_index + 1, at);
    if (gam.live_rank.enabled) {
      const others = (await experimentalPool(p, { finishedOnly: false })).filter((e) => e.id !== p.id);
      const live = game.liveRankAt(gam, questions, step.tokens_total, others.map((e) => e.responses), position);
      if (live.of >= gam.live_rank.min_pool) {
        await gameEvent(p.id, 'live_rank', questionId, live.ahead, at);
        await gameEvent(p.id, 'live_rank_pool', questionId, live.of, at);
      }
    }
  }

  async function ackFeedback(participant, n) {
    const fresh = await applyExpiry(participant);
    return tx(fresh, async (p) => {
      assertActive(p);
      if (p.current_step === 'FEEDBACK' && p.current_question === n) {
        if (n < totalQuestions) await update(p.id, { current_step: 'QUESTION', current_question: n + 1 });
        else await update(p.id, { current_step: afterQuestions, current_question: null });
        await logEvent(p.id, 'feedback_ack', { n });
        return;
      }
      // Repeat click after the participant already moved on.
      const movedOn =
        (p.current_step === 'QUESTION' && p.current_question === n + 1) || (STAGE[p.current_step] > STAGE.FEEDBACK && n <= totalQuestions);
      if (!movedOn) throw notYourTurn();
    });
  }

  // ---------- S5: score reveal ----------

  // Real experimental participants this one is compared with (same cohort; pilots only see
  // pilots), each with their closed responses.
  async function experimentalPool(p, { finishedOnly }) {
    const includePilot = gam.leaderboard.include_pilot_results;
    const pool = await db.all(
      `SELECT id, leaderboard_name, questions_finished_at FROM participants
       WHERE arm = 'experimental' AND status != 'withdrawn' ${finishedOnly ? 'AND questions_finished_at IS NOT NULL' : ''}
         AND (is_pilot = ? OR (? = 1 AND is_pilot = 1))`,
      [p.is_pilot, p.is_pilot === 0 && includePilot ? 1 : 0],
    );
    const byParticipant = new Map(pool.map((row) => [row.id, []]));
    if (pool.length) {
      const rows = await db.all(
        `SELECT * FROM question_responses WHERE participant_id IN (${pool.map(() => '?').join(',')})
         AND (answered_at IS NOT NULL OR expired = 1)`,
        pool.map((row) => row.id),
      );
      for (const r of rows) byParticipant.get(r.participant_id).push(r);
    }
    return pool.map((row) => ({ ...row, responses: byParticipant.get(row.id) }));
  }

  async function leaderboardEntries(p) {
    return (await experimentalPool(p, { finishedOnly: true })).map((row) => {
      const state = game.computeGameState(gam, questions, row.responses);
      return {
        id: row.id,
        name: row.leaderboard_name,
        tokens: state.tokens_total,
        score_raw: scoreRaw(row.responses),
        finished_at: row.questions_finished_at,
        total_time_ms: row.responses.reduce((sum, r) => sum + (r.time_taken_ms ?? 0), 0),
      };
    });
  }

  // Both groups get the same title and score sentence; the experimental group also gets its game results.
  async function getResults(participant) {
    const fresh = await applyExpiry(participant);
    return tx(fresh, async (p) => {
      assertActive(p);
      if (p.current_step !== 'FINAL') throw notYourTurn();
      const responses = await closedResponses(p.id);
      const screen = study.final_screen;
      const armText = p.arm === 'experimental' ? screen.experimental : screen.control;
      const out = { title: screen.title, paragraphs: armText.paragraphs, continue_button: screen.continue_button };
      if (armText.show_score) {
        const values = { correct: scoreRaw(responses), total: totalQuestions };
        out.score = { ...values, text: fillTemplate(screen.score_text, values) };
      }
      if (p.arm === 'experimental') {
        const state = game.computeGameState(gam, questions, responses);
        const { game: g, rank, poolSize } = game.finalGame(gam, state, await leaderboardEntries(p), p.id);
        out.game = g;
        // Record exactly what was shown, because the live leaderboard keeps changing.
        if (rank !== null && (gam.leaderboard.enabled || gam.rank.show !== 'none')) {
          const now = nowIso();
          await gameEvent(p.id, 'leaderboard_view', 'rank', rank, now);
          await gameEvent(p.id, 'leaderboard_view', 'pool_size', poolSize, now);
        }
      }
      await logEvent(p.id, 'results_viewed');
      return out;
    });
  }

  async function ackResults(participant) {
    return tx(participant, async (p) => {
      assertActive(p);
      if (STAGE[p.current_step] > STAGE.FINAL) return;
      if (p.current_step !== 'FINAL') throw notYourTurn();
      await update(p.id, { current_step: 'POST_SURVEY' });
      await logEvent(p.id, 'results_ack');
    });
  }

  // ---------- S7: debrief ----------

  async function complete(participant) {
    return tx(participant, async (p) => {
      assertActive(p);
      if (p.current_step !== 'DEBRIEF') throw notYourTurn('Please finish the last questions first.');
      if (p.status !== 'completed') {
        await update(p.id, { status: 'completed', completed_at: nowIso() });
        await logEvent(p.id, 'completed');
      }
      const d = study.debrief;
      return {
        title: d.title,
        paragraphs: d.paragraphs,
        code_label: d.code_label,
        code_help: d.code_help,
        participant_code: p.participant_code,
        withdraw_paragraphs: d.withdraw_paragraphs,
      };
    });
  }

  // ---------- stopping ----------

  async function withdraw(participant) {
    return tx(participant, async (p) => {
      if (p.status === 'completed') {
        throw notYourTurn('You have already finished. To remove your answers, give your participant code to the research team.');
      }
      if (p.status === 'in_progress') {
        await update(p.id, { status: 'abandoned', abandoned_at: nowIso() });
        await logEvent(p.id, 'withdrawn', { at_step: p.current_step, at_question: p.current_question });
      }
      return { step: 'WITHDRAWN', withdrawn: { title: study.withdraw.title, paragraphs: study.withdraw.paragraphs } };
    });
  }

  function publicTexts() {
    return {
      study_title: study.study_title,
      consent: study.consent,
      withdraw: { link_label: study.withdraw.link_label, confirm_text: study.withdraw.confirm_text },
      ui: study.ui,
    };
  }

  return {
    logEvent,
    applyExpiry,
    createParticipant,
    publicState,
    publicTexts,
    getSurvey,
    submitSurvey,
    ackInstructions,
    getQuestion,
    submitAnswer,
    ackFeedback,
    getResults,
    ackResults,
    complete,
    withdraw,
  };
}
