import { ApiError, newKey } from '../api.js';
import { h, heading, mount, whileBusy } from '../dom.js';

// Pre-test, post-test Part A (Q10) and Part B. Rendered entirely from survey.json via the
// server, section by section; every item is required.
const PHASE_OF_STEP = { PRE_SURVEY: 'pre', POST_SURVEY_A: 'post_a', POST_SURVEY: 'post' };

function scaleItem(item, number) {
  const values = [];
  for (let v = item.scale.min; v <= item.scale.max; v++) values.push(v);
  const name = `item-${item.id}`;
  return h(
    'fieldset',
    { class: 'likert', 'data-item': item.id },
    h('legend', {}, h('span', { class: 'item-number' }, `${number}.`), ' ', item.text),
    h(
      'div',
      { class: `likert-options${values.length > 7 ? ' wide' : ''}` },
      values.map((v) =>
        h(
          'label',
          { class: 'likert-option' },
          h('input', { type: 'radio', name, value: String(v) }),
          h('span', { class: 'likert-value' }, String(v)),
          item.scale.labels[String(v)] ? h('span', { class: 'likert-label' }, item.scale.labels[String(v)]) : null,
        ),
      ),
    ),
  );
}

function choiceItem(item, number) {
  const name = `item-${item.id}`;
  return h(
    'fieldset',
    { class: 'likert choice', 'data-item': item.id },
    h('legend', {}, h('span', { class: 'item-number' }, `${number}.`), ' ', item.text),
    h(
      'div',
      { class: 'choice-options' },
      item.options.map((o) =>
        h('label', { class: 'choice-option' }, h('input', { type: 'radio', name, value: String(o.value) }), h('span', {}, o.label)),
      ),
    ),
  );
}

export async function renderSurvey(ctx, state) {
  const phase = PHASE_OF_STEP[state.step];
  let survey;
  try {
    survey = await ctx.api('GET', `/api/survey/${phase}`);
  } catch (err) {
    return ctx.handleError(err);
  }

  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const fieldsets = [];
  let number = 0;
  const sections = survey.sections.map((section) => {
    const items = section.items.map((item) => {
      number += 1;
      const fs = item.type === 'choice' ? choiceItem(item, number) : scaleItem(item, number);
      fieldsets.push(fs);
      return fs;
    });
    return h(
      'section',
      { class: 'survey-section' },
      section.title ? h('h2', { class: 'survey-section-title' }, section.title) : null,
      section.stem ? h('p', { class: 'survey-stem' }, section.stem) : null,
      items,
    );
  });

  for (const fs of fieldsets) {
    fs.addEventListener('change', () => {
      fs.classList.remove('missing');
      if (!fieldsets.some((f) => f.classList.contains('missing'))) errorBox.hidden = true;
    });
  }

  const submit = h('button', { type: 'submit', class: 'primary' }, survey.submit_button);
  const form = h('form', { novalidate: true }, ...sections, errorBox, h('div', { class: 'actions' }, submit));
  const key = newKey();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const answers = {};
    let firstMissing = null;
    for (const fs of fieldsets) {
      const checked = fs.querySelector('input:checked');
      fs.classList.toggle('missing', !checked);
      if (checked) answers[fs.dataset.item] = Number(checked.value);
      else firstMissing ??= fs;
    }
    if (firstMissing) {
      errorBox.textContent = survey.missing_message;
      errorBox.hidden = false;
      firstMissing.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    errorBox.hidden = true;
    whileBusy(submit, async () => {
      const result = await ctx.api('POST', `/api/survey/${phase}`, { answers, idempotencyKey: key });
      ctx.show(result.state.step, result.state);
    }).catch((err) => {
      if (err instanceof ApiError && err.code === 'VALIDATION') {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      } else ctx.handleError(err);
    });
  });

  mount(ctx.root, heading(survey.title), survey.intro ? h('p', { class: 'muted' }, survey.intro) : null, form);
  ctx.root.querySelector('h1').focus();
}
