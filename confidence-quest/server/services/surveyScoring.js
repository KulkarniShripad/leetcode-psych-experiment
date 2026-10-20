import { AppError } from '../middleware/errors.js';
import { SURVEY_PHASES } from './content.js';

// Surveys are laid out per phase in survey.json: pre (before the questions) and post (after
// the score). Items keep the order they are listed in.

export function itemsForPhase(survey, phase) {
  const spec = survey.phases[phase];
  if (!spec) return [];
  const byId = new Map(survey.items.map((item) => [item.id, item]));
  return spec.sections.flatMap((section) => section.items.map((id) => byId.get(id)));
}

// What the participant's browser gets: texts, sections, and for each item its scale or options.
export function publicSurvey(survey, phase) {
  const spec = survey.phases[phase];
  const byId = new Map(survey.items.map((item) => [item.id, item]));
  return {
    phase,
    title: spec.title,
    intro: spec.intro,
    sections: spec.sections.map((section) => ({
      title: section.title ?? null,
      stem: section.stem ?? null,
      items: section.items.map((id) => {
        const item = byId.get(id);
        return item.type === 'choice'
          ? { id, text: item.text, type: 'choice', options: item.options.map((o) => ({ value: o.value, label: o.label })) }
          : { id, text: item.text, type: 'scale', scale: item.scale };
      }),
    })),
  };
}

export function allowedValues(item) {
  if (item.type === 'choice') return item.options.map((o) => o.value);
  const values = [];
  for (let v = item.scale.min; v <= item.scale.max; v++) values.push(v);
  return values;
}

// Checks a full submission: every item answered, every value allowed, nothing extra.
// Returns [{ item_id, value }] or throws a VALIDATION error with a plain message.
export function validateSurveySubmission(survey, phase, answers, missingMessage = 'Please answer every question.') {
  const items = itemsForPhase(survey, phase);
  const known = new Set(items.map((i) => i.id));
  for (const id of Object.keys(answers)) {
    if (!known.has(id)) throw new AppError('VALIDATION', 'The survey contained an answer to an unknown question.');
  }
  return items.map((item) => {
    const value = answers[item.id];
    if (value === undefined || value === null) throw new AppError('VALIDATION', missingMessage);
    if (!Number.isInteger(value) || !allowedValues(item).includes(value)) {
      throw new AppError(
        'VALIDATION',
        item.type === 'choice' ? 'Please choose one of the options.' : `An answer was outside the allowed range (${item.scale.min} to ${item.scale.max}).`,
      );
    }
    return { item_id: item.id, value };
  });
}

export function scoredValue(item, value) {
  if (item.type !== 'scale' || !item.reverse) return value;
  return item.scale.min + item.scale.max - value;
}

export function optionLabel(item, value) {
  return item?.type === 'choice' ? item.options.find((o) => o.value === value)?.label ?? null : null;
}

// Mean of one measure's scale items in one phase, after reverse-coding.
// `values` maps item_id -> raw value. Returns null if any item is missing.
export function measureMean(survey, measure, phase, values) {
  const items = itemsForPhase(survey, phase).filter((item) => item.measure === measure && item.type === 'scale');
  if (!items.length) return null;
  let sum = 0;
  for (const item of items) {
    if (values[item.id] === undefined) return null;
    sum += scoredValue(item, values[item.id]);
  }
  return sum / items.length;
}

export const confidenceMean = (survey, phase, values) => measureMean(survey, 'confidence', phase, values);

export { SURVEY_PHASES };
