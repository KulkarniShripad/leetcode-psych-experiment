import { h } from '../dom.js';
import { icon } from '../fx/icons.js';
import { fillBar } from '../fx/motion.js';

// The game bar shown on every question for the experimental group:
// tokens, current streak, level progress, badges and a dot per question.
export function renderHud(hud, currentN) {
  const items = [];
  if (hud.tokens) {
    items.push(h('div', { class: 'hud-stat hud-tokens', title: hud.tokens.label }, icon('coin', { size: 22 }), h('b', { 'data-testid': 'hud-tokens' }, String(hud.tokens.total)), h('span', {}, hud.tokens.label)));
  }
  if (hud.streak) {
    const hot = hud.streak.current >= 2;
    items.push(
      h(
        'div',
        { class: `hud-stat hud-streak${hot ? ' is-hot' : ''}${hud.streak.current >= 3 ? ' is-blazing' : ''}` },
        icon(hud.streak.current ? 'flame' : 'flameBroken', { size: 22 }),
        h('b', { 'data-testid': 'hud-streak' }, String(hud.streak.current)),
        h('span', {}, hud.streak.label),
      ),
    );
  }
  if (hud.level) {
    const fill = h('i', {});
    fillBar(fill, hud.level.progress);
    items.push(
      h(
        'div',
        { class: 'hud-level', title: hud.level.next_name ? `${hud.level.next_at} tokens to ${hud.level.next_name}` : 'Max level' },
        h('span', { class: 'hud-level-badge' }, icon('shield', { size: 20 }), h('b', {}, String(hud.level.number))),
        h('div', { class: 'hud-level-body' }, h('span', { class: 'hud-level-name' }, hud.level.name), h('div', { class: 'fx-bar small' }, fill)),
      ),
    );
  }
  if (hud.badges) {
    items.push(h('div', { class: 'hud-stat hud-badges' }, icon('star', { size: 20 }), h('b', {}, `${hud.badges.earned}/${hud.badges.total}`), h('span', {}, 'badges')));
  }
  const dots = hud.history
    ? h(
        'div',
        { class: 'hud-dots', 'aria-label': 'Answers so far' },
        Array.from({ length: hud.total_questions }, (_, i) => {
          const outcome = hud.history[i];
          const cls = outcome ? `dot-${outcome}` : i + 1 === currentN ? 'dot-current' : 'dot-pending';
          return h('span', { class: `hud-dot ${cls}` });
        }),
      )
    : null;
  return h('div', { class: 'hud', 'data-testid': 'hud' }, h('div', { class: 'hud-row' }, items), dots);
}
