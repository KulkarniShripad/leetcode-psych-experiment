import crypto from 'node:crypto';
import { fillTemplate } from '../util.js';

// Every rule lives in gamification.json. This file only knows how to apply rule *types*.

export function anyGameFeature(gam) {
  return gam.tokens.enabled || gam.badges.enabled || gam.leaderboard.enabled || gam.rank.show !== 'none';
}

export function tokensForResponse(gam, question, response) {
  if (!gam.tokens.enabled) return 0;
  const answered = response.selected_option !== null && response.selected_option !== undefined;
  const qualifies = gam.tokens.award_on === 'any_answer' ? answered : response.is_correct === 1;
  if (!qualifies) return 0;
  return gam.tokens.points_by_difficulty[question.difficulty_label] ?? gam.tokens.default_points;
}

function badgeMet(criteria, tally) {
  switch (criteria.type) {
    case 'answered_count':
      return tally.answered >= criteria.gte;
    case 'correct_count':
      return tally.correct >= criteria.gte;
    case 'correct_streak':
      return tally.bestStreak >= criteria.gte;
    case 'section_all_correct':
      return (tally.sectionCorrect[criteria.section] ?? 0) === tally.sectionSize[criteria.section];
    default:
      return false;
  }
}

// Level reached with `total` tokens: the last level whose threshold is met.
export function levelFor(gam, total) {
  const list = gam.levels.list;
  let index = 0;
  list.forEach((level, i) => {
    if (total >= level.at) index = i;
  });
  const current = list[index];
  const next = list[index + 1] ?? null;
  return {
    index,
    number: index + 1,
    name: current.name,
    at: current.at,
    next_name: next?.name ?? null,
    next_at: next?.at ?? null,
    progress: next ? (total - current.at) / (next.at - current.at) : 1,
  };
}

// Replays the stored responses (in position order) and works out what happened at each one.
// Because it runs on stored answers, what a participant sees always matches the data.
export function computeGameState(gam, questions, responses) {
  const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  const sectionSize = {};
  for (const q of questions) sectionSize[q.section] = (sectionSize[q.section] ?? 0) + 1;
  const tally = { answered: 0, correct: 0, streak: 0, bestStreak: 0, sectionCorrect: {}, sectionSize };
  const bonusRule = gam.tokens.streak_bonus;
  const earned = new Set();
  const steps = [];
  let total = 0;
  for (const r of [...responses].sort((a, b) => a.position - b.position)) {
    const q = byId[r.question_id];
    const correct = r.is_correct === 1;
    const streakBefore = tally.streak;
    if (r.selected_option !== null && r.selected_option !== undefined) tally.answered++;
    if (correct) {
      tally.correct++;
      tally.streak++;
      tally.bestStreak = Math.max(tally.bestStreak, tally.streak);
      tally.sectionCorrect[q.section] = (tally.sectionCorrect[q.section] ?? 0) + 1;
    } else {
      tally.streak = 0;
    }
    const base = tokensForResponse(gam, q, r);
    const bonus = gam.tokens.enabled && bonusRule.enabled && correct && tally.streak >= bonusRule.min_streak ? bonusRule.bonus : 0;
    const before = total;
    total += base + bonus;
    const newBadges = [];
    if (gam.badges.enabled) {
      for (const badge of gam.badges.definitions) {
        if (!earned.has(badge.key) && badgeMet(badge.criteria, tally)) {
          earned.add(badge.key);
          newBadges.push(badge.key);
        }
      }
    }
    steps.push({
      position: r.position,
      question_id: r.question_id,
      outcome: r.expired === 1 && !r.selected_option ? 'expired' : correct ? 'correct' : 'incorrect',
      tokens: base + bonus,
      base_tokens: base,
      streak_bonus: bonus,
      tokens_before: before,
      tokens_total: total,
      streak: tally.streak,
      streak_lost: !correct && streakBefore >= 2 ? streakBefore : 0,
      best_streak: tally.bestStreak,
      level_index: levelFor(gam, total).index,
      leveled_up: gam.levels.enabled && levelFor(gam, total).index > levelFor(gam, before).index,
      new_badges: newBadges,
    });
  }
  return {
    steps,
    tokens_total: total,
    badges: [...earned],
    correct: tally.correct,
    streak: tally.streak,
    best_streak: tally.bestStreak,
  };
}

function describeBadges(gam, keys) {
  return keys.map((key) => {
    const badge = gam.badges.definitions.find((b) => b.key === key);
    return { key, name: badge.name, description: badge.description, icon: badge.icon };
  });
}

const pick = (list, i) => list[i % list.length];

function titleFor(gam, step) {
  const o = gam.overlay;
  if (step.outcome === 'expired') return { title: o.expired_title, subtitle: pick(o.encouragement, step.position) };
  if (step.outcome === 'incorrect') return { title: pick(o.incorrect_titles, step.position), subtitle: pick(o.encouragement, step.position) };
  const streakTitle = gam.streaks.enabled
    ? [...o.streak_titles].sort((a, b) => b.from - a.from).find((t) => step.streak >= t.from)
    : null;
  return { title: streakTitle ? streakTitle.text : pick(o.correct_titles, step.position), subtitle: null };
}

// The always-visible game bar shown on each question (state after `state.steps`).
export function hudState(gam, state, totalQuestions) {
  const hud = { total_questions: totalQuestions };
  if (gam.tokens.enabled) hud.tokens = { label: gam.tokens.label, total: state.tokens_total };
  if (gam.streaks.enabled) hud.streak = { label: gam.streaks.label, current: state.streak, best: state.best_streak };
  if (gam.levels.enabled) hud.level = levelFor(gam, state.tokens_total);
  if (gam.badges.enabled) hud.badges = { earned: state.badges.length, total: gam.badges.definitions.length };
  if (gam.hud.show_answer_dots) hud.history = state.steps.map((s) => s.outcome);
  return hud;
}

// Everything shown with the feedback for one question: the full-screen overlay and the card.
// `liveRank` ({ ahead, of }) is what was recorded when the answer came in, if anything.
export function feedbackGame(gam, state, position, { liveRank = null, totalQuestions = 9 } = {}) {
  const step = state.steps.find((s) => s.position === position);
  const game = {};
  if (!step) return game;
  const steps = state.steps.filter((s) => s.position <= position);
  const soFar = steps.flatMap((s) => s.new_badges);

  game.outcome = step.outcome;
  if (gam.tokens.enabled && (gam.feedback_panel.show_tokens_earned || gam.feedback_panel.show_total_tokens)) {
    game.tokens = { label: gam.tokens.label };
    if (gam.feedback_panel.show_tokens_earned) {
      game.tokens.earned = step.tokens;
      game.tokens.base = step.base_tokens;
      game.tokens.streak_bonus = step.streak_bonus;
    }
    if (gam.feedback_panel.show_total_tokens) {
      game.tokens.total = step.tokens_total;
      game.tokens.previous_total = step.tokens_before;
    }
  }
  if (gam.streaks.enabled) {
    game.streak = {
      label: gam.streaks.label,
      current: step.streak,
      best: step.best_streak,
      lost: step.streak_lost,
      text: step.streak >= 2 ? fillTemplate(gam.overlay.streak_text, { n: step.streak }) : null,
      lost_text: step.streak_lost ? fillTemplate(gam.overlay.streak_lost_text, { n: step.streak_lost }) : null,
    };
  }
  if (gam.levels.enabled) {
    const level = levelFor(gam, step.tokens_total);
    game.level = { ...level, leveled_up: step.leveled_up, previous_progress: levelFor(gam, step.tokens_before).progress };
    if (step.leveled_up) game.level.level_up_text = fillTemplate(gam.overlay.level_up_text, { name: level.name, number: level.number });
  }
  if (gam.badges.enabled && gam.feedback_panel.show_new_badges) {
    game.badges = {
      new: describeBadges(gam, step.new_badges),
      earned: describeBadges(gam, soFar),
      unlocked_text: gam.overlay.badge_unlocked_text,
    };
  }
  if (gam.live_rank.enabled && liveRank && liveRank.of >= gam.live_rank.min_pool) {
    const leading = liveRank.ahead === liveRank.of;
    game.live_rank = {
      ...liveRank,
      text: fillTemplate(leading ? gam.live_rank.leading_text : gam.live_rank.text, { ahead: liveRank.ahead, of: liveRank.of, n: position }),
    };
  }
  if (gam.hud.enabled) {
    const upTo = { steps, tokens_total: step.tokens_total, streak: step.streak, best_streak: step.best_streak, badges: soFar };
    game.hud = hudState(gam, upTo, totalQuestions);
  }
  if (gam.overlay.enabled) {
    game.overlay = {
      ...titleFor(gam, step),
      min_display_ms: gam.overlay.min_display_ms,
      confetti: gam.overlay.confetti,
      shake: gam.overlay.shake_on_incorrect,
      sound: gam.sound.enabled,
    };
  }
  return game;
}

// Live comparison during the test: among other players who have already closed question
// `position`, how many had fewer tokens at that point? Real participants only.
export function liveRankAt(gam, questions, myTotal, others, position) {
  let of = 0;
  let ahead = 0;
  for (const responses of others) {
    const upTo = responses.filter((r) => r.position <= position);
    if (upTo.length < position) continue;
    of++;
    if (computeGameState(gam, questions, upTo).tokens_total < myTotal) ahead++;
  }
  return { ahead, of };
}

function compareTie(tieBreak) {
  if (tieBreak === 'earlier_finish') return (a, b) => (a.finished_at < b.finished_at ? -1 : a.finished_at > b.finished_at ? 1 : 0);
  if (tieBreak === 'less_total_time') return (a, b) => a.total_time_ms - b.total_time_ms;
  return () => 0;
}

// Ranks real entries only: [{ id, name, tokens, score_raw, finished_at, total_time_ms }].
export function rankEntries(gam, entries) {
  const { metric, tie_break: tieBreak } = gam.leaderboard;
  const value = (e) => (metric === 'tokens' ? e.tokens : e.score_raw);
  const tie = compareTie(tieBreak);
  const sorted = entries
    .map((e) => ({ ...e, value: value(e) }))
    .sort((a, b) => b.value - a.value || tie(a, b) || (a.id < b.id ? -1 : 1));
  sorted.forEach((e, i) => {
    e.rank = tieBreak === 'shared' && i > 0 && e.value === sorted[i - 1].value ? sorted[i - 1].rank : i + 1;
  });
  return sorted;
}

// Everything the experimental final screen shows. `entries` must include the viewer.
export function finalGame(gam, state, entries, viewerId) {
  const game = { headline: gam.final.headline };
  if (gam.tokens.enabled) game.tokens = { label: gam.tokens.label, total: state.tokens_total };
  if (gam.streaks.enabled) game.streak = { label: gam.streaks.label, best: state.best_streak ?? 0 };
  if (gam.levels.enabled) game.level = levelFor(gam, state.tokens_total);
  if (gam.badges.enabled) {
    game.badges = {
      earned: describeBadges(gam, state.badges),
      all: gam.badges.definitions.map((b) => ({
        key: b.key,
        name: b.name,
        description: b.description,
        icon: b.icon,
        earned: state.badges.includes(b.key),
      })),
    };
  }
  const ranked = rankEntries(gam, entries);
  const self = ranked.find((e) => e.id === viewerId);
  if (gam.leaderboard.enabled) {
    const row = (e) => ({ rank: e.rank, name: e.name, value: e.value, is_self: e.id === viewerId });
    const top = ranked.slice(0, gam.leaderboard.top_n).map(row);
    game.leaderboard = {
      title: gam.leaderboard.title,
      metric_label: gam.leaderboard.metric_label,
      self_label: gam.leaderboard.self_label,
      rows: top,
      self_row: gam.leaderboard.include_self_row && self && !top.some((r) => r.is_self) ? row(self) : null,
      empty_text: ranked.length <= 1 ? gam.leaderboard.empty_text : null,
    };
  }
  // A rank among one player says nothing, so the lines start once someone else has finished.
  if (gam.rank.show !== 'none' && self) {
    const values = { rank: self.rank, of: ranked.length, top_percent: Math.ceil((100 * self.rank) / ranked.length) };
    game.rank = { ...values, lines: [] };
    if (ranked.length >= 2 && (gam.rank.show === 'rank' || gam.rank.show === 'both')) game.rank.lines.push(fillTemplate(gam.rank.rank_text, values));
    if (ranked.length >= 2 && (gam.rank.show === 'percentile' || gam.rank.show === 'both')) {
      game.rank.lines.push(fillTemplate(gam.rank.percentile_text, values));
    }
  }
  const topPercent = self ? Math.ceil((100 * self.rank) / ranked.length) : 100;
  const answered = state.steps?.length ?? 0;
  const perfect = answered > 0 && state.correct === answered;
  game.celebrate = gam.overlay.confetti && (topPercent <= gam.final.confetti_top_percent || perfect);
  return { game, rank: self?.rank ?? null, poolSize: ranked.length };
}

export function pickLeaderboardName(gam, isTaken) {
  const { adjectives, nouns } = gam.leaderboard.names;
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = `${adjectives[crypto.randomInt(adjectives.length)]} ${nouns[crypto.randomInt(nouns.length)]}`;
    if (!isTaken(name)) return name;
  }
  for (let n = 2; ; n++) {
    const name = `${adjectives[crypto.randomInt(adjectives.length)]} ${nouns[crypto.randomInt(nouns.length)]} ${n}`;
    if (!isTaken(name)) return name;
  }
}
