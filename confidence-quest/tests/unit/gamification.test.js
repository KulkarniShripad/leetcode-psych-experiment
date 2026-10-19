import { describe, expect, it } from 'vitest';
import { loadContent } from '../../server/services/content.js';
import {
  computeGameState, feedbackGame, finalGame, hudState, levelFor, liveRankAt, rankEntries,
} from '../../server/services/gamification.js';
import { CONTENT_DIR, wrongLetter } from '../helpers.js';

const content = loadContent(CONTENT_DIR);
const { questions, answerKey } = content;
const clone = (x) => JSON.parse(JSON.stringify(x));
const gam = () => clone(content.gamification);

const responses = (choose) =>
  questions.map((q, i) => {
    const option = choose(q.id, i + 1);
    return { question_id: q.id, position: i + 1, selected_option: option, is_correct: option === answerKey[q.id] ? 1 : 0 };
  });
const allCorrect = responses((id) => answerKey[id]);

describe('tokens and badges', () => {
  it('awards 1/2/3 by difficulty for correct answers, plus +1 per answer while on a streak of 2+', () => {
    const state = computeGameState(gam(), questions, allCorrect);
    expect(state.steps.map((s) => s.base_tokens)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3]);
    expect(state.steps.map((s) => s.streak_bonus)).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(state.tokens_total).toBe(18 + 8);
    expect(computeGameState(gam(), questions, responses((id) => wrongLetter(answerKey[id]))).tokens_total).toBe(0);
    const noBonus = gam();
    noBonus.tokens.streak_bonus.enabled = false;
    expect(computeGameState(noBonus, questions, allCorrect).tokens_total).toBe(18);
  });

  it('tracks the current streak, best streak and a lost streak', () => {
    // right, right, right, WRONG, right, right, WRONG, right, right
    const state = computeGameState(gam(), questions, responses((id, n) => ([4, 7].includes(n) ? wrongLetter(answerKey[id]) : answerKey[id])));
    expect(state.steps.map((s) => s.streak)).toEqual([1, 2, 3, 0, 1, 2, 0, 1, 2]);
    expect(state.steps.map((s) => s.streak_lost)).toEqual([0, 0, 0, 3, 0, 0, 2, 0, 0]);
    expect(state.best_streak).toBe(3);
    expect(state.streak).toBe(2);
  });

  it('levels up at the configured token thresholds', () => {
    const state = computeGameState(gam(), questions, allCorrect);
    expect(state.steps.map((s) => s.tokens_total)).toEqual([1, 4, 8, 10, 13, 17, 19, 22, 26]);
    expect(state.steps.filter((s) => s.leveled_up).map((s) => s.position)).toEqual([2, 4, 6, 8]);
    expect(levelFor(gam(), 0)).toMatchObject({ number: 1, name: 'Rookie', next_name: 'Apprentice', next_at: 4, progress: 0 });
    expect(levelFor(gam(), 12)).toMatchObject({ number: 3, name: 'Coder', next_at: 15, progress: 0.5 });
    expect(levelFor(gam(), 99)).toMatchObject({ number: 5, name: 'Legend', next_name: null, progress: 1 });
  });

  it('changes only when gamification.json changes', () => {
    const g = gam();
    g.tokens.streak_bonus.enabled = false;
    g.tokens.points_by_difficulty = { Easy: 5, Medium: 5, Hard: 5 };
    expect(computeGameState(g, questions, allCorrect).tokens_total).toBe(45);
    g.tokens.award_on = 'any_answer';
    expect(computeGameState(g, questions, responses((id) => wrongLetter(answerKey[id]))).tokens_total).toBe(45);
    g.tokens.enabled = false;
    expect(computeGameState(g, questions, allCorrect).tokens_total).toBe(0);
  });

  it('effort badges come even with every answer wrong', () => {
    const state = computeGameState(gam(), questions, responses((id) => wrongLetter(answerKey[id])));
    const earnedAt = state.steps.flatMap((s) => s.new_badges.map((b) => [b, s.position]));
    expect(earnedAt).toEqual([['halfway', 5], ['finisher', 9]]);
    const fb = feedbackGame(gam(), state, 9);
    expect(fb.badges.new).toEqual([{ key: 'finisher', name: 'Finisher', description: 'Answered all nine questions', icon: 'trophy' }]);
  });

  it('a perfect run unlocks all eight badges at the right moments', () => {
    const state = computeGameState(gam(), questions, allCorrect);
    const earnedAt = Object.fromEntries(state.steps.flatMap((s) => s.new_badges.map((b) => [b, s.position])));
    expect(earnedAt).toEqual({
      off_the_mark: 1, hot_streak: 3, window_master: 3, halfway: 5, pointer_pro: 6, array_ace: 9, finisher: 9, perfect_run: 9,
    });
  });

  it('supports streak, count and section badge rules from config', () => {
    const g = gam();
    g.badges.definitions = [
      { key: 'streak3', name: 'Three in a row', description: '', criteria: { type: 'correct_streak', gte: 3 } },
      { key: 'five', name: 'Five right', description: '', criteria: { type: 'correct_count', gte: 5 } },
      { key: 'arrays', name: 'Arrays master', description: '', criteria: { type: 'section_all_correct', section: 'Arrays' } },
    ];
    const state = computeGameState(g, questions, allCorrect);
    const earnedAt = Object.fromEntries(state.steps.flatMap((s) => s.new_badges.map((b) => [b, s.position])));
    expect(earnedAt).toEqual({ streak3: 3, five: 5, arrays: 9 });
  });

  it('the feedback panel follows its show_* switches', () => {
    const g = gam();
    g.feedback_panel = { show_tokens_earned: false, show_total_tokens: true, show_new_badges: false };
    const fb = feedbackGame(g, computeGameState(g, questions, allCorrect), 2);
    expect(fb.tokens).toEqual({ label: 'tokens', total: 4, previous_total: 1 });
    expect(fb).not.toHaveProperty('badges');
  });
});

describe('full-screen feedback, HUD and live rank', () => {
  it('picks streak titles for hot streaks and encouragement for misses', () => {
    const state = computeGameState(gam(), questions, responses((id, n) => (n === 5 ? wrongLetter(answerKey[id]) : answerKey[id])));
    const at = (n) => feedbackGame(gam(), state, n);
    expect(at(1).overlay.title).toBe('Nailed it!');
    expect(at(2).overlay.title).toBe('Double up!');
    expect(at(3).overlay.title).toBe('On fire!');
    expect(at(4).overlay.title).toBe('Unstoppable!');
    expect(at(4).streak.text).toBe('4 in a row');
    expect(at(5).outcome).toBe('incorrect');
    expect(at(5).overlay.title).toBe('So close');
    expect(at(5).overlay.subtitle).toBeTruthy();
    expect(at(5).streak.lost_text).toBe('4-answer streak lost');
    expect(at(4).level).toMatchObject({ leveled_up: true, level_up_text: 'Level up! Level 3: Coder' });
    expect(at(5).tokens).toMatchObject({ earned: 0, total: 10 });
  });

  it('turning the overlay off in config removes it', () => {
    const g = gam();
    g.overlay.enabled = false;
    expect(feedbackGame(g, computeGameState(g, questions, allCorrect), 1)).not.toHaveProperty('overlay');
  });

  it('the HUD shows tokens, streak, level, badges and one dot per answered question', () => {
    const state = computeGameState(gam(), questions, responses((id, n) => (n === 2 ? wrongLetter(answerKey[id]) : answerKey[id])).slice(0, 3));
    const hud = hudState(gam(), state, 9);
    expect(hud).toMatchObject({
      total_questions: 9,
      tokens: { total: 4 },
      streak: { current: 1, best: 1 },
      level: { name: 'Apprentice' },
      badges: { earned: 1, total: 8 },
      history: ['correct', 'incorrect', 'correct'],
    });
  });

  it('live rank compares with real players who already closed the same question', () => {
    const others = [
      responses((id) => answerKey[id]), // 1 token after Q1
      responses((id) => wrongLetter(answerKey[id])), // 0 after Q1
      responses((id) => answerKey[id]).slice(0, 0), // has not reached Q1: not counted
    ];
    expect(liveRankAt(gam(), questions, 1, others, 1)).toEqual({ ahead: 1, of: 2 });
    expect(liveRankAt(gam(), questions, 5, others, 1)).toEqual({ ahead: 2, of: 2 });
    const fb = feedbackGame(gam(), computeGameState(gam(), questions, allCorrect), 1, { liveRank: { ahead: 2, of: 2 } });
    expect(fb.live_rank.text).toBe("You're leading all 2 players at question 1!");
    const behind = feedbackGame(gam(), computeGameState(gam(), questions, allCorrect), 1, { liveRank: { ahead: 1, of: 4 } });
    expect(behind.live_rank.text).toBe("You're ahead of 1 of 4 players at question 1");
  });
});

describe('leaderboard', () => {
  const entry = (id, tokens, finishedAt, totalTime = 1000) => ({
    id,
    name: `Name ${id}`,
    tokens,
    score_raw: tokens,
    finished_at: finishedAt,
    total_time_ms: totalTime,
  });

  it('ranks by tokens and breaks ties by earlier finish', () => {
    const ranked = rankEntries(gam(), [entry('a', 10, '2026-10-19T10:05:00Z'), entry('b', 10, '2026-10-19T10:01:00Z'), entry('c', 12, '2026-10-19T10:09:00Z')]);
    expect(ranked.map((e) => [e.id, e.rank])).toEqual([['c', 1], ['b', 2], ['a', 3]]);
  });

  it('supports shared ranks and less-total-time tie-breaking', () => {
    const entries = [entry('a', 10, 't1', 900), entry('b', 10, 't2', 500), entry('c', 4, 't3', 100)];
    const shared = gam();
    shared.leaderboard.tie_break = 'shared';
    expect(rankEntries(shared, entries).map((e) => e.rank)).toEqual([1, 1, 3]);
    const time = gam();
    time.leaderboard.tie_break = 'less_total_time';
    expect(rankEntries(time, entries).map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('shows the top N plus the viewer row, and rank/percentile text', () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(`p${i}`, 20 - i, `2026-10-19T10:0${i}:00Z`));
    const state = { tokens_total: 13, badges: ['finisher'] };
    const { game, rank, poolSize } = finalGame(gam(), state, entries, 'p7');
    expect(game.leaderboard.rows.map((r) => r.name)).toEqual(['Name p0', 'Name p1', 'Name p2', 'Name p3', 'Name p4']);
    expect(game.leaderboard.self_row).toEqual({ rank: 8, name: 'Name p7', value: 13, is_self: true });
    expect([rank, poolSize]).toEqual([8, 8]);
    expect(game.rank.lines).toEqual(['You are ranked 8 of 8.', 'That puts you in the top 100%.']);

    const inTop = finalGame(gam(), state, entries, 'p1').game;
    expect(inTop.leaderboard.self_row).toBeNull();
    expect(inTop.leaderboard.rows[1].is_self).toBe(true);
  });

  it('never invents entries: a lone participant sees only themselves', () => {
    const { game } = finalGame(gam(), { tokens_total: 5, badges: [] }, [entry('solo', 5, 't')], 'solo');
    expect(game.leaderboard.rows).toHaveLength(1);
    expect(game.leaderboard.empty_text).toMatch(/first to finish/);
  });

  it('rank can be switched off or limited to the percentile', () => {
    const g = gam();
    g.rank.show = 'none';
    expect(finalGame(g, { tokens_total: 1, badges: [] }, [entry('x', 1, 't')], 'x').game.rank).toBeUndefined();
    g.rank.show = 'percentile';
    const two = [entry('x', 1, 't1'), entry('y', 5, 't2')];
    expect(finalGame(g, { tokens_total: 1, badges: [] }, two, 'x').game.rank.lines).toEqual(['That puts you in the top 100%.']);
    // Alone on the board: rank is recorded but no line is shown.
    expect(finalGame(gam(), { tokens_total: 1, badges: [] }, [entry('x', 1, 't')], 'x').game.rank).toMatchObject({ rank: 1, of: 1, lines: [] });
  });
});
