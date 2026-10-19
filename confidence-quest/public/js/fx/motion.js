// Shared animation helpers. Everything respects the OS "reduce motion" setting.

export function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// Counts a number up (or down) inside `el`.
export function countUp(el, from, to, ms = 900, format = (n) => String(n)) {
  if (reducedMotion() || from === to) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  el.textContent = format(from);
  requestAnimationFrame(step);
}

// Sets a progress bar fill (0..1), animating from `from` when given.
export function fillBar(fillEl, to, from = null) {
  const pct = (v) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
  if (from === null || reducedMotion()) {
    fillEl.style.width = pct(to);
    return;
  }
  fillEl.style.width = pct(from);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fillEl.style.width = pct(to);
  }));
}
