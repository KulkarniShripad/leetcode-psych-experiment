import { h, mount } from '../dom.js';
import { icon, resultMark } from './icons.js';
import { confetti } from './confetti.js';
import { countUp, fillBar, reducedMotion } from './motion.js';
import { playCorrect, playIncorrect, playLevelUp } from './sound.js';

// Full-screen animated feedback after an answer (experimental group only).
// Everything it shows comes from the server's `game` object.
export function showAnswerOverlay({ correct, game, nextLabel, onNext }) {
  const o = game.overlay;
  const parts = [];
  let delay = 0;
  const stagger = (el, step = 140) => {
    el.style.setProperty('--fx-delay', `${(delay += step)}ms`);
    el.classList.add('fx-in');
    return el;
  };

  parts.push(h('div', { class: 'fx-mark' }, resultMark(correct)));
  parts.push(stagger(h('h2', { class: 'fx-title', id: 'fx-title', 'data-testid': 'fx-title' }, o.title), 120));
  if (o.subtitle) parts.push(stagger(h('p', { class: 'fx-subtitle' }, o.subtitle)));

  const t = game.tokens;
  if (t && 'earned' in t) {
    const chips = [h('span', { class: `fx-chip fx-chip-tokens${t.earned ? '' : ' is-zero'}` }, icon('coin', { size: 26 }), `+${t.earned} ${t.label}`)];
    if (t.streak_bonus) chips.push(h('span', { class: 'fx-chip fx-chip-bonus' }, icon('bolt', { size: 20 }), `+${t.streak_bonus} streak bonus`));
    parts.push(stagger(h('div', { class: 'fx-rewards' }, chips)));
  }

  const s = game.streak;
  if (s?.text) {
    const heat = Math.min(s.current, 6);
    parts.push(stagger(h('div', { class: `fx-streak heat-${heat}`, 'data-testid': 'fx-streak' }, icon('flame', { size: 30 + heat * 6 }), h('span', {}, s.text))));
  } else if (s?.lost_text) {
    parts.push(stagger(h('div', { class: 'fx-streak-lost' }, icon('flameBroken', { size: 34 }), h('span', {}, s.lost_text))));
  }

  const lv = game.level;
  let levelFill = null;
  if (lv) {
    levelFill = h('i', {});
    const label = lv.next_name ? `${t?.total ?? ''} / ${lv.next_at} to ${lv.next_name}` : 'Max level';
    parts.push(
      stagger(
        h(
          'div',
          { class: `fx-level${lv.leveled_up ? ' is-up' : ''}` },
          h('span', { class: 'fx-level-badge' }, icon('shield', { size: 22 }), h('b', {}, String(lv.number))),
          h('div', { class: 'fx-level-body' }, h('div', { class: 'fx-level-name' }, lv.name), h('div', { class: 'fx-bar' }, levelFill), h('div', { class: 'fx-level-label' }, label)),
        ),
      ),
    );
    if (lv.level_up_text) parts.push(stagger(h('div', { class: 'fx-levelup', 'data-testid': 'fx-levelup' }, lv.level_up_text)));
  }

  for (const badge of game.badges?.new ?? []) {
    parts.push(
      stagger(
        h(
          'div',
          { class: 'fx-badge-unlock', 'data-testid': 'fx-badge' },
          h('span', { class: `badge-medallion badge-${badge.icon}` }, icon(badge.icon, { size: 34 })),
          h('div', {}, h('div', { class: 'fx-badge-kicker' }, game.badges.unlocked_text), h('div', { class: 'fx-badge-name' }, badge.name), h('div', { class: 'fx-badge-desc' }, badge.description)),
        ),
        200,
      ),
    );
  }

  if (game.live_rank) parts.push(stagger(h('p', { class: 'fx-rank', 'data-testid': 'fx-rank' }, icon('rank', { size: 22 }), game.live_rank.text)));

  let totalEl = null;
  if (t && 'total' in t) {
    totalEl = h('b', {}, String(t.previous_total ?? t.total));
    parts.push(stagger(h('p', { class: 'fx-total' }, icon('coin', { size: 20 }), totalEl, ` ${t.label} in total`)));
  }

  const next = h('button', { type: 'button', class: 'fx-next', 'data-testid': 'fx-next', hidden: true }, `${nextLabel} →`);
  parts.push(next);

  const overlay = h(
    'div',
    {
      class: `fx-overlay ${correct ? 'fx-correct' : 'fx-incorrect'}${o.shake && !correct ? ' fx-shake' : ''}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'fx-title',
      'data-testid': 'fx-overlay',
    },
    h('div', { class: 'fx-rays', 'aria-hidden': 'true' }),
    mount(h('div', { class: 'fx-stage' }), ...parts),
  );
  document.body.append(overlay);
  document.body.classList.add('fx-open');

  if (correct && o.confetti) confetti(overlay, { count: 90 + Math.min(s?.current ?? 0, 6) * 25, originY: 0.28 });
  if (lv?.leveled_up && o.confetti) setTimeout(() => confetti(overlay, { count: 120, originY: 0.55, spread: 1.2 }), 700);
  if (o.sound) {
    if (correct) playCorrect(s?.current ?? 1);
    else playIncorrect();
    if (lv?.leveled_up) playLevelUp();
  }
  if (levelFill) fillBar(levelFill, lv.progress, lv.leveled_up ? 0 : lv.previous_progress);
  if (totalEl) setTimeout(() => countUp(totalEl, t.previous_total ?? t.total, t.total, 700), reducedMotion() ? 0 : delay);

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey);
    overlay.classList.add('fx-out');
    document.body.classList.remove('fx-open');
    setTimeout(() => overlay.remove(), reducedMotion() ? 0 : 250);
  };
  const go = async () => {
    next.disabled = true;
    try {
      await onNext();
      close();
    } catch (err) {
      close();
      throw err;
    }
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  next.addEventListener('click', () => go().catch(() => {}));
  setTimeout(() => {
    next.hidden = false;
    next.focus();
  }, Math.max(o.min_display_ms, reducedMotion() ? 0 : delay));
  return { close };
}
