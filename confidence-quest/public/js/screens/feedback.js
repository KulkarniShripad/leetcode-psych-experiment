import { h, heading, mount, whileBusy } from '../dom.js';
import { showAnswerOverlay } from '../fx/overlay.js';
import { renderGamePanel } from './gamePanel.js';
import { renderHud } from './hud.js';

// S4. 'Correct' or 'Incorrect' only; the right option is never revealed.
// Control: this plain card. Experimental: the same card with the game panel underneath, and
// right after answering (`animate`) a full-screen animated overlay on top of it.
export function renderFeedback(ctx, state, { animate = false } = {}) {
  const fb = state.feedback;
  ctx.setProgress(null);
  const advance = async () => {
    const result = await ctx.api('POST', '/api/next', { n: fb.n });
    ctx.show(result.state.step, result.state);
  };
  const next = h('button', { type: 'button', class: 'primary' }, fb.next_button);
  next.addEventListener('click', () => whileBusy(next, advance).catch(ctx.handleError));
  mount(
    ctx.root,
    fb.game?.hud ? renderHud(fb.game.hud, null) : null,
    h('p', { class: 'eyebrow' }, `${fb.n} / ${state.total ?? state.total_questions}`),
    h(
      'div',
      { class: `result ${fb.correct ? 'result-correct' : 'result-incorrect'}`, 'data-testid': 'result' },
      heading(fb.text),
    ),
    fb.game ? renderGamePanel(fb.game) : null,
    h('div', { class: 'actions' }, next),
  );
  ctx.root.querySelector('h1').focus();
  if (animate && fb.game?.overlay) {
    showAnswerOverlay({
      correct: fb.correct,
      game: fb.game,
      nextLabel: fb.next_button,
      onNext: () => advance().catch((err) => ctx.handleError(err)),
    });
  }
}
