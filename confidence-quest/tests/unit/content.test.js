import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContentError, loadContent } from '../../server/services/content.js';
import { itemsForPhase } from '../../server/services/surveyScoring.js';
import { compareWithAppendix, loadAppendix } from '../../scripts/lib/appendix.js';
import { CONTENT_DIR, contentCopy } from '../helpers.js';

const problemsFor = (dir) => {
  try {
    loadContent(dir);
    return [];
  } catch (err) {
    if (err instanceof ContentError) return err.problems;
    throw err;
  }
};

describe('content files', () => {
  it('load and validate', () => {
    const content = loadContent(CONTENT_DIR);
    expect(content.questions).toHaveLength(9);
    expect(Object.keys(content.answerKey)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9']);
  });

  it('questions.json and answer_key.json match Appendix A exactly', () => {
    const content = loadContent(CONTENT_DIR);
    expect(compareWithAppendix(content)).toEqual([]);
    const source = loadAppendix(CONTENT_DIR);
    expect(source.questions).toHaveLength(9);
    expect(source.answerKey).toEqual({ Q1: 'D', Q2: 'C', Q3: 'A', Q4: 'B', Q5: 'D', Q6: 'A', Q7: 'B', Q8: 'C', Q9: 'D' });
    for (const [i, q] of source.questions.entries()) {
      const json = content.questions[i];
      expect({ ...json, options_format: undefined }).toEqual({ ...q, options_format: undefined });
    }
  });

  it('keeps code whitespace exactly (indentation and trailing comment)', () => {
    const q6 = loadContent(CONTENT_DIR).questionsById.Q6;
    expect(q6.code).toContain('\n        a[mid], a[hi] = a[hi], a[mid]; hi -= 1; mid += 1   # bug\n');
  });

  it('a silent edit to a question is caught', () => {
    const dir = contentCopy({
      'questions.json': (json) => {
        json.questions[4].options[1].text = '[[-2, 0, 2]] ';
      },
    });
    expect(compareWithAppendix(loadContent(dir))).toEqual([expect.stringContaining('Q5.options.B')]);
  });

  it('C1-C6 are identical before and after: same stem, scale, wording and order', () => {
    const { survey } = loadContent(CONTENT_DIR);
    const conf = (phase) =>
      itemsForPhase(survey, phase)
        .filter((i) => i.measure === 'confidence')
        .map((i) => `${i.id}|${i.text}|${JSON.stringify(i.scale)}`);
    expect(conf('pre')).toEqual(conf('post'));
    expect(conf('pre')).toHaveLength(6);
    const stem = (phase) => survey.phases[phase].sections.find((s) => s.items.includes('C1')).stem;
    expect(stem('pre')).toBe('How confident are you that you can do each of the following right now?');
    expect(stem('post')).toBe(stem('pre'));
    expect(itemsForPhase(survey, 'pre')[0].scale.labels).toEqual({ 1: 'Not at all confident', 4: 'Moderately confident', 7: 'Extremely confident' });
  });

  it('follows the final questionnaire order exactly', () => {
    const { survey } = loadContent(CONTENT_DIR);
    const ids = (phase) => itemsForPhase(survey, phase).map((i) => i.id);
    expect(ids('pre')).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'P1', 'P2']);
    expect(ids('post_a')).toEqual(['Q10']);
    // Q12 is the only item that names badges, tokens or a leaderboard, so it comes last.
    expect(ids('post')).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'Q11', 'Q13', 'Q14', 'Q12']);
    expect(survey.phases.pre.intro).toBe(
      'Your answers are anonymous and used only for research. There are no right or wrong answers, so please answer honestly.',
    );
  });

  it('never mentions game features in the surveys, except Q12 at the very end', () => {
    const { survey } = loadContent(CONTENT_DIR);
    const words = /\b(gamif\w*|badges?|tokens?|leaderboards?|points?|streaks?|levels?|rank(s|ed|ing)?)\b/i;
    const texts = [];
    for (const phase of ['pre', 'post_a', 'post']) {
      const spec = survey.phases[phase];
      texts.push(spec.title, spec.intro, ...spec.sections.flatMap((s) => [s.title ?? '', s.stem ?? '']));
      for (const item of itemsForPhase(survey, phase)) {
        if (item.id === 'Q12') continue;
        texts.push(item.text, ...(item.options ?? []).map((o) => o.label), ...Object.values(item.scale?.labels ?? {}));
      }
    }
    expect(texts.filter((t) => words.test(t))).toEqual([]);
  });

  it('collects no names, emails, IDs, gender or age', () => {
    const { survey } = loadContent(CONTENT_DIR);
    const personal = /\bname\b|e-?mail|student id|roll|gender|\bsex\b|\bage\b|birth|phone/i;
    expect(survey.items.filter((i) => personal.test(i.text)).map((i) => i.id)).toEqual([]);
  });

  it('fails if the confidence items differ between pre and post', () => {
    const reordered = contentCopy({
      'survey.json': (json) => {
        json.phases.post.sections[0].items = ['C2', 'C1', 'C3', 'C4', 'C5', 'C6'];
      },
    });
    expect(problemsFor(reordered)).toEqual([expect.stringMatching(/^survey\.json: phases\.post: the confidence items must be asked .* same order/)]);
    const restemmed = contentCopy({
      'survey.json': (json) => {
        json.phases.post.sections[0].stem = 'How confident are you now?';
      },
    });
    expect(problemsFor(restemmed)).toEqual([expect.stringMatching(/same stem/)]);
    const dropped = contentCopy({
      'survey.json': (json) => {
        json.phases.pre.sections[0].items = ['C1', 'C2', 'C3', 'C4', 'C5'];
      },
    });
    expect(problemsFor(dropped).join('\n')).toMatch(/C6 is not asked in phases\.pre/);
  });

  it('fails if a survey references an unknown item or scale, or Q10 is not 0-9', () => {
    const unknownItem = contentCopy({
      'survey.json': (json) => {
        json.phases.post.sections[1].items.push('Q99');
      },
    });
    expect(problemsFor(unknownItem)).toEqual(['survey.json: phases.post.sections[1]: no item with id Q99']);
    const unknownScale = contentCopy({
      'survey.json': (json) => {
        json.items.find((i) => i.id === 'Q13').scale = 'agree_5';
      },
    });
    expect(problemsFor(unknownScale)).toEqual([expect.stringMatching(/scale: no scale called "agree_5"/)]);
    const badGuess = contentCopy({
      'survey.json': (json) => {
        json.scales.count_0_9.max = 10;
      },
    });
    expect(problemsFor(badGuess)).toEqual(['survey.json: Q10.scale: the postdiction scale must run from 0 to 9']);
  });

  it('names the file and field for each kind of problem', () => {
    const missing = contentCopy();
    fs.rmSync(path.join(missing, 'gamification.json'));
    expect(problemsFor(missing)).toEqual([expect.stringMatching(/^gamification\.json: file is missing/)]);

    const badJson = contentCopy();
    fs.writeFileSync(path.join(badJson, 'study.json'), '{ not json');
    expect(problemsFor(badJson)).toEqual([expect.stringMatching(/^study\.json: not valid JSON/)]);

    const badKey = contentCopy({ 'answer_key.json': (json) => ({ ...json, Q3: 'E' }) });
    expect(problemsFor(badKey)).toEqual([expect.stringMatching(/^answer_key\.json: Q3: /)]);

    const missingAnswer = contentCopy({
      'answer_key.json': (json) => {
        delete json.Q9;
      },
    });
    expect(problemsFor(missingAnswer)).toEqual(['answer_key.json: Q9: missing answer for question Q9']);

    const badScale = contentCopy({
      'survey.json': (json) => {
        json.scales.confidence_7.max = 'seven';
      },
    });
    expect(problemsFor(badScale)).toEqual([expect.stringMatching(/^survey\.json: scales\.confidence_7\.max: /)]);

    const badBadge = contentCopy({
      'gamification.json': (json) => {
        json.badges.definitions[0].criteria = { type: 'speed_demon', gte: 1 };
      },
    });
    expect(problemsFor(badBadge)).toEqual([expect.stringMatching(/^gamification\.json: badges\.definitions\.0\.criteria\.type: /)]);

    const badSection = contentCopy({
      'gamification.json': (json) => {
        json.badges.definitions.push({ key: 'arrays', name: 'Arrays', criteria: { type: 'section_all_correct', section: 'Graphs' } });
      },
    });
    expect(problemsFor(badSection)).toEqual([expect.stringMatching(/badges\.definitions\[8\]\.criteria\.section: no section called "Graphs"/)]);

    const oddBlock = contentCopy({
      'study.json': (json) => {
        json.allocation.block_size = 3;
      },
    });
    expect(problemsFor(oddBlock)).toEqual([expect.stringMatching(/^study\.json: allocation\.block_size: must be an even number/)]);
  });

  it('warns while texts and rules are still placeholders', () => {
    const { warnings } = loadContent(CONTENT_DIR);
    expect(warnings.join('\n')).toMatch(/D4-D7/);
    // The final questionnaires are approved, so there is no survey warning any more.
    expect(warnings.join('\n')).not.toMatch(/survey\.json/);
  });
});
