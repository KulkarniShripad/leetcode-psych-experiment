import { describe, expect, it } from 'vitest';
import {
  confidenceMean, itemsForPhase, optionLabel, publicSurvey, scoredValue, validateSurveySubmission,
} from '../../server/services/surveyScoring.js';

const seven = { min: 1, max: 7, labels: {} };
const survey = {
  items: [
    { id: 'a', measure: 'confidence', type: 'scale', reverse: false, text: 'A', scale: seven },
    { id: 'b', measure: 'confidence', type: 'scale', reverse: true, text: 'B', scale: seven },
    { id: 'c', measure: 'enjoyment', type: 'scale', reverse: false, text: 'C', scale: { min: 1, max: 5, labels: {} } },
    {
      id: 'm',
      measure: 'manipulation_check',
      type: 'choice',
      reverse: false,
      text: 'M',
      options: [{ value: 1, label: 'Yes' }, { value: 2, label: 'No' }, { value: 3, label: 'Not sure' }],
    },
  ],
  phases: {
    pre: { title: 'Pre', intro: '', sections: [{ stem: 'How confident?', items: ['a', 'b'] }] },
    post: { title: 'Post', intro: '', sections: [{ stem: 'How confident?', items: ['a', 'b'] }, { items: ['c', 'm'] }] },
  },
};
const item = (id) => survey.items.find((i) => i.id === id);

describe('survey layout', () => {
  it('lists items per phase in the order of the sections', () => {
    expect(itemsForPhase(survey, 'pre').map((i) => i.id)).toEqual(['a', 'b']);
    expect(itemsForPhase(survey, 'post').map((i) => i.id)).toEqual(['a', 'b', 'c', 'm']);
  });

  it('sends the browser sections, stems, scales and options, but not scoring details', () => {
    const pub = publicSurvey(survey, 'post');
    expect(pub.sections[0]).toMatchObject({ stem: 'How confident?', title: null });
    expect(pub.sections[1].items[1]).toEqual({
      id: 'm',
      text: 'M',
      type: 'choice',
      options: [{ value: 1, label: 'Yes' }, { value: 2, label: 'No' }, { value: 3, label: 'Not sure' }],
    });
    expect(pub.sections[0].items[1]).not.toHaveProperty('reverse');
    expect(pub.sections[0].items[1]).not.toHaveProperty('measure');
  });
});

describe('survey scoring', () => {
  it('reverse-codes on the item scale', () => {
    expect(scoredValue(item('b'), 2)).toBe(6);
    expect(scoredValue(item('b'), 7)).toBe(1);
    expect(scoredValue(item('a'), 2)).toBe(2);
    expect(scoredValue(item('m'), 2)).toBe(2);
  });

  it('confidence score is the mean of the confidence items, computed per phase', () => {
    // a = 5, b = 3 reversed to 5 -> mean 5
    expect(confidenceMean(survey, 'pre', { a: 5, b: 3 })).toBe(5);
    expect(confidenceMean(survey, 'post', { a: 4, b: 4 })).toBe(4);
  });

  it('gives conf_change of +1.0 for 4.0 pre and 5.0 post', () => {
    const pre = confidenceMean(survey, 'pre', { a: 4, b: 4 });
    const post = confidenceMean(survey, 'post', { a: 5, b: 3 });
    expect(post - pre).toBe(1);
  });

  it('returns null when an item is missing', () => {
    expect(confidenceMean(survey, 'pre', { a: 4 })).toBeNull();
  });

  it('labels choice answers', () => {
    expect(optionLabel(item('m'), 3)).toBe('Not sure');
    expect(optionLabel(item('a'), 3)).toBeNull();
  });
});

describe('survey validation', () => {
  it('accepts a complete submission', () => {
    expect(validateSurveySubmission(survey, 'post', { a: 1, b: 7, c: 5, m: 3 })).toEqual([
      { item_id: 'a', value: 1 },
      { item_id: 'b', value: 7 },
      { item_id: 'c', value: 5 },
      { item_id: 'm', value: 3 },
    ]);
  });

  it('rejects a missing item', () => {
    expect(() => validateSurveySubmission(survey, 'pre', { a: 4 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('rejects out-of-range, non-integer and unknown-option values', () => {
    expect(() => validateSurveySubmission(survey, 'pre', { a: 8, b: 4 })).toThrow(/outside the allowed range/);
    expect(() => validateSurveySubmission(survey, 'pre', { a: 0, b: 4 })).toThrow(/outside the allowed range/);
    expect(() => validateSurveySubmission(survey, 'post', { a: 4, b: 4, c: 6, m: 1 })).toThrow(/1 to 5/);
    expect(() => validateSurveySubmission(survey, 'pre', { a: 4.5, b: 4 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => validateSurveySubmission(survey, 'post', { a: 4, b: 4, c: 3, m: 4 })).toThrow(/choose one of the options/);
  });

  it('rejects answers to items that are not in this phase', () => {
    expect(() => validateSurveySubmission(survey, 'pre', { a: 4, b: 4, c: 3 })).toThrow(/unknown question/);
  });
});
