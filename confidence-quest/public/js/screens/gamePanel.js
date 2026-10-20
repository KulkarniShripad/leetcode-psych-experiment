import { h } from '../dom.js';
import { icon } from '../fx/icons.js';
import { confetti } from '../fx/confetti.js';
import { countUp, fillBar } from '../fx/motion.js';

// Experimental group only. Everything shown here comes from the server, which computes it
// from stored answers using gamification.json.

// The card under the feedback (and what a refreshed page shows instead of the overlay).
export function renderGamePanel(game) {
  const parts = [];
  if (game.tokens) {
    const t = game.tokens;
    const line = [];
    if ('earned' in t) line.push(h('span', { class: 'token-earned' }, `+${t.earned} ${t.label}`));
    if (t.streak_bonus) line.push(h('span', { class: 'token-bonus' }, `incl. +${t.streak_bonus} streak bonus`));
    if ('total' in t) line.push(h('span', { class: 'token-total' }, `${t.total} ${t.label} in total`));
    parts.push(h('div', { class: 'game-tokens' }, icon('coin', { size: 24 }), ...line));
  }
  if (game.streak?.text) parts.push(h('div', { class: 'game-line game-streak' }, icon('flame', { size: 22 }), game.streak.text));
  else if (game.streak?.lost_text) parts.push(h('div', { class: 'game-line game-streak-lost' }, icon('flameBroken', { size: 22 }), game.streak.lost_text));
  if (game.level) {
    const fill = h('i', {});
    fillBar(fill, game.level.progress);
    parts.push(
      h(
        'div',
        { class: 'game-level' },
        h('span', { class: 'hud-level-badge' }, icon('shield', { size: 20 }), h('b', {}, String(game.level.number))),
        h('div', { class: 'hud-level-body' }, h('span', { class: 'hud-level-name' }, game.level.level_up_text ?? game.level.name), h('div', { class: 'fx-bar' }, fill)),
      ),
    );
  }
  for (const badge of game.badges?.new ?? []) {
    parts.push(
      h(
        'div',
        { class: 'game-badge new' },
        h('span', { class: `badge-medallion small badge-${badge.icon}` }, icon(badge.icon, { size: 20 })),
        h('strong', {}, `${game.badges.unlocked_text}: ${badge.name}`),
        badge.description ? h('span', { class: 'muted' }, ` — ${badge.description}`) : null,
      ),
    );
  }
  if (game.live_rank) parts.push(h('div', { class: 'game-line game-live-rank' }, icon('rank', { size: 20 }), game.live_rank.text));
  return h('section', { class: 'game-panel', 'data-testid': 'game-panel', 'aria-label': 'Game progress' }, parts);
}

// The experimental results reveal on the final screen (S5).
export function renderResultsReveal(game) {
  const tiles = [];
  const counters = [];
  const tile = (iconName, value, label, cls = '') => {
    const num = h('b', {}, String(value));
    counters.push([num, value]);
    return h('div', { class: `reveal-tile ${cls}` }, icon(iconName, { size: 30 }), num, h('span', {}, label));
  };
  if (game.tokens) tiles.push(tile('coin', game.tokens.total, game.tokens.label, 'tile-tokens'));
  if (game.streak) tiles.push(tile('flame', game.streak.best, `best ${game.streak.label}`, 'tile-streak'));
  if (game.badges) tiles.push(tile('star', game.badges.earned.length, `of ${game.badges.all.length} badges`, 'tile-badges'));

  const sections = [
    h('div', { class: 'reveal-hero' }, h('span', { class: 'reveal-trophy' }, icon('trophy', { size: 72 })), h('h2', {}, game.headline)),
  ];
  if (game.level) {
    const fill = h('i', {});
    fillBar(fill, game.level.progress, 0);
    sections.push(
      h(
        'div',
        { class: 'reveal-level' },
        h('span', { class: 'fx-level-badge big' }, icon('shield', { size: 40 }), h('b', {}, String(game.level.number))),
        h(
          'div',
          { class: 'fx-level-body' },
          h('div', { class: 'fx-level-name' }, `Level ${game.level.number}: ${game.level.name}`),
          h('div', { class: 'fx-bar' }, fill),
          h('div', { class: 'fx-level-label' }, game.level.next_name ? `${game.level.next_at} tokens for ${game.level.next_name}` : 'Max level reached'),
        ),
      ),
    );
  }
  if (tiles.length) sections.push(h('div', { class: 'reveal-tiles' }, tiles));
  if (game.rank?.lines.length) {
    sections.push(
      h('div', { class: 'reveal-rank', 'data-testid': 'reveal-rank' }, icon('rank', { size: 28 }), h('div', {}, game.rank.lines.map((line, i) => h(i ? 'p' : 'strong', {}, line)))),
    );
  }
  if (game.badges) {
    sections.push(
      h(
        'div',
        { class: 'badge-grid', 'data-testid': 'badge-grid' },
        game.badges.all.map((b) =>
          h(
            'div',
            { class: `badge-card${b.earned ? ' is-earned' : ' is-locked'}`, title: b.description },
            h('span', { class: `badge-medallion badge-${b.icon}` }, icon(b.earned ? b.icon : 'lock', { size: 26 })),
            h('span', { class: 'badge-card-name' }, b.name),
            h('span', { class: 'badge-card-desc' }, b.description),
          ),
        ),
      ),
    );
  }
  if (game.leaderboard) sections.push(renderLeaderboard(game.leaderboard));

  const root = h('section', { class: 'results-reveal', 'data-testid': 'game-panel', 'aria-label': 'Your game results' }, sections);
  requestAnimationFrame(() => {
    counters.forEach(([el, value], i) => setTimeout(() => countUp(el, 0, value, 1000), 250 + i * 150));
    if (game.celebrate) confetti(document.body, { count: 180, originY: 0.2, spread: 1.3, duration: 3200 });
  });
  return root;
}

function renderLeaderboard(lb) {
  const row = (r) =>
    h(
      'tr',
      { class: `lb-row${r.is_self ? ' self' : ''}` },
      h('td', { class: 'lb-rank' }, r.rank <= 3 ? h('span', { class: `podium podium-${r.rank}` }, String(r.rank)) : String(r.rank)),
      h('td', {}, r.is_self ? `${r.name} (${lb.self_label})` : r.name),
      h('td', { class: 'num' }, String(r.value)),
    );
  const body = lb.rows.map(row);
  if (lb.self_row) body.push(h('tr', { class: 'gap' }, h('td', { colspan: '3' }, '…')), row(lb.self_row));
  body.forEach((tr, i) => tr.style.setProperty('--row-delay', `${400 + i * 120}ms`));
  return h(
    'div',
    { class: 'leaderboard', 'data-testid': 'leaderboard' },
    h('h2', {}, lb.title),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Player'), h('th', { class: 'num' }, lb.metric_label))),
      h('tbody', {}, body),
    ),
    lb.empty_text ? h('p', { class: 'muted' }, lb.empty_text) : null,
  );
}
