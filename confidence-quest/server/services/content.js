import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../util.js';

export const CONTENT_FILES = ['questions.json', 'answer_key.json', 'survey.json', 'gamification.json', 'study.json'];
export const OPTION_KEYS = ['A', 'B', 'C', 'D'];
export const DONT_KNOW = 'IDK';

// Checks without trimming: question text must reach participants exactly as written.
const text = z.string().refine((s) => s.trim().length > 0, 'must not be empty');
const paragraphs = z.array(z.string());

const questionSchema = z
  .object({
    id: z.string().regex(/^Q\d+$/, 'must look like Q1, Q2, ...'),
    section: text,
    difficulty_label: text,
    prompt: z.string(),
    language: z.string().optional(),
    code: z.string().optional(),
    note: z.string().optional(),
    options_format: z.enum(['code', 'text']).default('code'),
    options: z
      .array(z.object({ key: z.enum(['A', 'B', 'C', 'D']), text: text }).strict())
      .length(4)
      .refine((opts) => opts.every((o, i) => o.key === OPTION_KEYS[i]), 'options must be A, B, C, D in that order'),
  })
  .strict();

const questionsSchema = z.object({
  version: text,
  source: z.string().optional(),
  questions: z.array(questionSchema).min(1),
});

const answerKeySchema = z.record(z.string(), z.enum(['A', 'B', 'C', 'D']));

const scaleSchema = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .refine((s) => s.min < s.max, 'min must be smaller than max');

const MEASURES = [
  'confidence',
  'postdiction',
  'relative_performance',
  'manipulation_check',
  'pressure',
  'enjoyment',
  'prior_experience',
  'practice_frequency',
  'competitiveness',
  'other',
];

export const SURVEY_PHASES = ['pre', 'post_a', 'post'];

const surveyItemSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_]{1,64}$/, 'use letters, digits and _ only'),
    measure: z.enum(MEASURES),
    type: z.enum(['scale', 'choice']).default('scale'),
    text: text,
    // A scale is a name from `scales` or written out in place.
    scale: z.union([z.string(), scaleSchema]).optional(),
    options: z.array(z.object({ value: z.number().int(), label: text }).strict()).min(2).optional(),
    reverse: z.boolean().default(false),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.type === 'scale' && !item.scale) ctx.addIssue({ code: 'custom', path: ['scale'], message: 'a scale item needs a scale' });
    if (item.type === 'choice' && !item.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'a choice item needs options' });
    if (item.type === 'choice' && item.reverse) ctx.addIssue({ code: 'custom', path: ['reverse'], message: 'only scale items can be reverse-coded' });
  });

const surveyPhaseSchema = z
  .object({
    title: text,
    intro: z.string().default(''),
    sections: z
      .array(z.object({ title: z.string().optional(), stem: z.string().optional(), items: z.array(z.string()).min(1) }).strict())
      .min(1),
  })
  .strict();

const surveySchema = z.object({
  status: z.string().optional(),
  note: z.string().optional(),
  scales: z.record(z.string(), scaleSchema).default({}),
  items: z.array(surveyItemSchema).min(1),
  // pre: before the questions. post_a: right after Q9, before any score. post: after the score.
  phases: z.object({ pre: surveyPhaseSchema, post_a: surveyPhaseSchema.optional(), post: surveyPhaseSchema }).strict(),
});

export const BADGE_ICONS = ['star', 'flame', 'bolt', 'trophy', 'target', 'medal', 'rocket', 'crown'];

const criteriaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answered_count'), gte: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal('correct_count'), gte: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal('correct_streak'), gte: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal('section_all_correct'), section: text }).strict(),
]);

const gamificationSchema = z.object({
  status: z.string().optional(),
  note: z.string().optional(),
  instructions_extra: z.string().default(''),
  tokens: z
    .object({
      enabled: z.boolean(),
      label: text,
      award_on: z.enum(['correct', 'any_answer']),
      points_by_difficulty: z.record(z.string(), z.number().int().min(0)),
      default_points: z.number().int().min(0).default(0),
      streak_bonus: z
        .object({ enabled: z.boolean(), min_streak: z.number().int().min(2), bonus: z.number().int().min(0) })
        .strict(),
    })
    .strict(),
  streaks: z.object({ enabled: z.boolean(), label: text }).strict(),
  levels: z
    .object({
      enabled: z.boolean(),
      list: z
        .array(z.object({ at: z.number().int().min(0), name: text }).strict())
        .min(1)
        .refine((list) => list[0].at === 0, 'the first level must start at 0')
        .refine((list) => list.every((l, i) => i === 0 || l.at > list[i - 1].at), 'levels must go up in order'),
    })
    .strict(),
  badges: z
    .object({
      enabled: z.boolean(),
      definitions: z.array(
        z
          .object({
            key: z.string().regex(/^[a-z0-9_]{1,40}$/, 'use lowercase letters, digits and _ only'),
            name: text,
            description: z.string().default(''),
            icon: z.enum(BADGE_ICONS).default('star'),
            criteria: criteriaSchema,
          })
          .strict(),
      ),
    })
    .strict(),
  feedback_panel: z
    .object({
      show_tokens_earned: z.boolean(),
      show_total_tokens: z.boolean(),
      show_new_badges: z.boolean(),
    })
    .strict(),
  leaderboard: z
    .object({
      enabled: z.boolean(),
      title: text,
      metric: z.enum(['tokens', 'score_raw']),
      metric_label: text,
      top_n: z.number().int().min(1).max(100),
      include_self_row: z.boolean(),
      include_pilot_results: z.boolean(),
      tie_break: z.enum(['earlier_finish', 'less_total_time', 'shared']),
      names: z.object({ adjectives: z.array(text).min(1), nouns: z.array(text).min(1) }).strict(),
      self_label: text,
      empty_text: z.string(),
    })
    .strict(),
  rank: z
    .object({
      show: z.enum(['none', 'rank', 'percentile', 'both']),
      rank_text: text,
      percentile_text: text,
    })
    .strict(),
  overlay: z
    .object({
      enabled: z.boolean(),
      min_display_ms: z.number().int().min(0).max(10000),
      confetti: z.boolean(),
      shake_on_incorrect: z.boolean(),
      correct_titles: z.array(text).min(1),
      streak_titles: z.array(z.object({ from: z.number().int().min(2), text }).strict()),
      incorrect_titles: z.array(text).min(1),
      encouragement: z.array(text).min(1),
      expired_title: text,
      streak_text: text,
      streak_lost_text: text,
      level_up_text: text,
      badge_unlocked_text: text,
    })
    .strict(),
  hud: z.object({ enabled: z.boolean(), show_answer_dots: z.boolean() }).strict(),
  live_rank: z
    .object({ enabled: z.boolean(), min_pool: z.number().int().min(1), text: text, leading_text: text })
    .strict(),
  sound: z.object({ enabled: z.boolean() }).strict(),
  final: z.object({ headline: text, confetti_top_percent: z.number().int().min(0).max(100) }).strict(),
});

const studySchema = z.object({
  status: z.string().optional(),
  note: z.string().optional(),
  study_title: text,
  consent: z.object({
    version: text,
    title: text,
    paragraphs,
    checkbox_label: text,
    agree_button: text,
    decline_button: text,
    declined_title: text,
    declined_paragraphs: paragraphs,
  }),
  surveys: z.object({ submit_button: text, missing_message: text }),
  instructions: z.object({ title: text, paragraphs, start_button: text }),
  questions: z.object({
    order: z.enum(['fixed', 'random_per_participant']),
    show_section: z.boolean(),
    show_difficulty_labels: z.boolean(),
    dont_know_option: z.object({ enabled: z.boolean(), label: text }),
    time_limit: z.object({
      enabled: z.boolean(),
      total_seconds: z.number().int().min(30),
      on_expiry: z.literal('end_test'),
    }),
    submit_button: text,
    progress_text: text,
  }),
  feedback: z.object({ correct_text: text, incorrect_text: text, next_button: text, last_button: text }),
  final_screen: z.object({
    title: text,
    score_text: text,
    control: z.object({ show_score: z.boolean(), paragraphs }),
    experimental: z.object({ show_score: z.boolean(), paragraphs }),
    continue_button: text,
  }),
  debrief: z.object({
    title: text,
    paragraphs,
    code_label: text,
    code_help: z.string(),
    withdraw_paragraphs: paragraphs,
  }),
  withdraw: z.object({ link_label: text, confirm_text: text, title: text, paragraphs }),
  ui: z.object({ connection_lost: text, retry_button: text, generic_error: text, time_left_label: text }),
  allocation: z.object({
    block_size: z
      .number()
      .int()
      .min(2)
      .refine((n) => n % 2 === 0, 'must be an even number'),
    main_slots: z.number().int().min(2),
    pilot_slots: z.number().int().min(2),
    separate_pilot_list: z.boolean(),
  }),
});

const SCHEMAS = {
  'questions.json': questionsSchema,
  'answer_key.json': answerKeySchema,
  'survey.json': surveySchema,
  'gamification.json': gamificationSchema,
  'study.json': studySchema,
};

export class ContentError extends Error {
  constructor(problems) {
    super(`Content check failed:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

const describePath = (p) => (p.length ? p.join('.') : '(top level)');

// Loads and validates every content file. Throws ContentError naming each bad file and field.
export function loadContent(dir) {
  const problems = [];
  const raw = {};
  const hashes = {};
  for (const file of CONTENT_FILES) {
    const full = path.join(dir, file);
    let source;
    try {
      source = fs.readFileSync(full, 'utf8');
    } catch {
      problems.push(`${file}: file is missing (looked in ${dir})`);
      continue;
    }
    hashes[file] = sha256(source);
    let json;
    try {
      json = JSON.parse(source);
    } catch (err) {
      problems.push(`${file}: not valid JSON (${err.message})`);
      continue;
    }
    const parsed = SCHEMAS[file].safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${file}: ${describePath(issue.path)}: ${issue.message}`);
      continue;
    }
    raw[file] = parsed.data;
  }
  if (problems.length) throw new ContentError(problems);

  const content = {
    dir,
    hashes,
    questionsVersion: raw['questions.json'].version,
    questions: raw['questions.json'].questions,
    answerKey: raw['answer_key.json'],
    survey: raw['survey.json'],
    gamification: raw['gamification.json'],
    study: raw['study.json'],
  };
  problems.push(...crossCheck(content));
  if (problems.length) throw new ContentError(problems);

  content.questionsById = Object.fromEntries(content.questions.map((q) => [q.id, q]));
  // From here on every scale item carries its scale object (named scales resolved).
  content.survey.items = content.survey.items.map((item) =>
    item.type === 'choice' ? item : { ...item, scale_name: typeof item.scale === 'string' ? item.scale : null, scale: resolveScale(content.survey, item) },
  );
  content.warnings = collectWarnings(content);
  return content;
}

function crossCheck({ questions, answerKey, survey, gamification }) {
  const problems = [];
  const ids = questions.map((q) => q.id);
  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i) problems.push(`questions.json: questions[${i}].id: duplicate id ${id}`);
  });
  for (const id of ids) {
    if (!(id in answerKey)) problems.push(`answer_key.json: ${id}: missing answer for question ${id}`);
  }
  for (const id of Object.keys(answerKey)) {
    if (!ids.includes(id)) problems.push(`answer_key.json: ${id}: no question with this id in questions.json`);
  }

  problems.push(...checkSurvey(survey, questions.length));

  const sections = new Set(questions.map((q) => q.section));
  const badgeKeys = new Set();
  gamification.badges.definitions.forEach((badge, i) => {
    if (badgeKeys.has(badge.key)) problems.push(`gamification.json: badges.definitions[${i}].key: duplicate key ${badge.key}`);
    badgeKeys.add(badge.key);
    if (badge.criteria.type === 'section_all_correct' && !sections.has(badge.criteria.section)) {
      problems.push(
        `gamification.json: badges.definitions[${i}].criteria.section: no section called "${badge.criteria.section}" in questions.json`,
      );
    }
  });
  if (gamification.leaderboard.enabled && gamification.leaderboard.metric === 'tokens' && !gamification.tokens.enabled) {
    problems.push('gamification.json: leaderboard.metric: the leaderboard ranks by tokens but tokens are disabled');
  }
  return problems;
}

// Survey rules that protect the design: every referenced item exists, the confidence items
// are asked before and after with the same stem, wording and order, and Q10 runs 0..N.
function checkSurvey(survey, questionCount) {
  const problems = [];
  const byId = new Map();
  survey.items.forEach((item, i) => {
    if (byId.has(item.id)) problems.push(`survey.json: items[${i}].id: duplicate id ${item.id}`);
    byId.set(item.id, item);
    if (typeof item.scale === 'string' && !(item.scale in survey.scales)) {
      problems.push(`survey.json: items[${i}].scale: no scale called "${item.scale}" in scales`);
      return;
    }
    const scale = resolveScale(survey, item);
    if (scale) {
      for (const label of Object.keys(scale.labels)) {
        const v = Number(label);
        if (!Number.isInteger(v) || v < scale.min || v > scale.max) {
          problems.push(`survey.json: items[${i}] (${item.id}): label ${label} is outside the scale ${scale.min}-${scale.max}`);
        }
      }
    }
    if (item.options) {
      const values = item.options.map((o) => o.value);
      if (new Set(values).size !== values.length) problems.push(`survey.json: items[${i}].options: values must be different`);
    }
  });

  const layout = {};
  for (const phase of SURVEY_PHASES) {
    const spec = survey.phases[phase];
    if (!spec) continue;
    const seen = new Set();
    layout[phase] = [];
    spec.sections.forEach((section, si) => {
      section.items.forEach((id) => {
        if (!byId.has(id)) problems.push(`survey.json: phases.${phase}.sections[${si}]: no item with id ${id}`);
        if (seen.has(id)) problems.push(`survey.json: phases.${phase}: ${id} is listed twice`);
        seen.add(id);
        layout[phase].push({ id, stem: section.stem ?? null });
      });
    });
  }

  const confidence = (phase) => (layout[phase] ?? []).filter((e) => byId.get(e.id)?.measure === 'confidence');
  const pre = confidence('pre');
  const post = confidence('post');
  if (!pre.length) problems.push('survey.json: phases.pre: at least one confidence item is needed');
  const sameOrder = pre.length === post.length && pre.every((e, i) => e.id === post[i].id && e.stem === post[i].stem);
  if (!sameOrder) {
    problems.push(
      'survey.json: phases.post: the confidence items must be asked after the questions with the same stem and in the same order as before (pre and post must match for the change score)',
    );
  }
  for (const item of survey.items.filter((it) => it.measure === 'confidence')) {
    if (!pre.some((e) => e.id === item.id)) problems.push(`survey.json: confidence item ${item.id} is not asked in phases.pre`);
  }
  if ((layout.post_a ?? []).some((e) => byId.get(e.id)?.measure === 'confidence')) {
    problems.push('survey.json: phases.post_a: confidence items belong in pre and post, not post_a');
  }

  for (const item of survey.items.filter((it) => it.measure === 'postdiction')) {
    const scale = resolveScale(survey, item);
    if (scale && (scale.min !== 0 || scale.max !== questionCount)) {
      problems.push(`survey.json: ${item.id}.scale: the postdiction scale must run from 0 to ${questionCount}`);
    }
  }
  return problems;
}

export function resolveScale(survey, item) {
  if (item.type === 'choice' || !item.scale) return null;
  return typeof item.scale === 'string' ? survey.scales[item.scale] ?? null : item.scale;
}

function collectWarnings({ survey, gamification, study, questions }) {
  const warnings = [];
  if (survey.status !== 'approved') warnings.push('survey.json is not marked approved yet (D9).');
  const used = new Set(SURVEY_PHASES.flatMap((phase) => survey.phases[phase]?.sections.flatMap((s) => s.items) ?? []));
  const unused = survey.items.filter((item) => !used.has(item.id)).map((item) => item.id);
  if (unused.length) warnings.push(`survey.json: items not asked in any survey: ${unused.join(', ')}.`);
  if (gamification.status !== 'approved') warnings.push('gamification.json rules are provisional, not approved (D4-D7, D17).');
  if (study.status !== 'approved') warnings.push('study.json texts (consent, instructions, debrief) are placeholders (D1, D2, D8).');
  if (/PLACEHOLDER/i.test(study.consent.version)) warnings.push('Consent version is still marked PLACEHOLDER (D1).');
  if (gamification.tokens.enabled) {
    const missing = [...new Set(questions.map((q) => q.difficulty_label))].filter(
      (label) => !(label in gamification.tokens.points_by_difficulty),
    );
    if (missing.length) {
      warnings.push(`gamification.json: no token value for ${missing.join(', ')}; default_points is used.`);
    }
  }
  return warnings;
}
