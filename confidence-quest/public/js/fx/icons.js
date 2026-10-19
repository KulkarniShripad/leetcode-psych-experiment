// Inline SVG icons (no emoji: lab machines often lack an emoji font).
const SVG_NS = 'http://www.w3.org/2000/svg';

// Each icon: list of [tag, attributes]. Colours come from CSS (currentColor + classes).
const ICONS = {
  coin: [
    ['circle', { cx: 12, cy: 12, r: 10, class: 'i-coin-outer' }],
    ['circle', { cx: 12, cy: 12, r: 7.2, class: 'i-coin-inner' }],
    ['path', { d: 'M12 7.5 15.2 12 12 16.5 8.8 12Z', class: 'i-coin-gem' }],
  ],
  flame: [
    ['path', { d: 'M12 1.8c.9 3.6 5.6 5.9 5.6 11.4A5.6 5.6 0 0 1 6.4 13.2c0-2.6 1.2-4.4 2.7-5.8.1 2.1 1 3.4 2.3 3.9-.8-3.4-.3-6.4.6-9.5Z', class: 'i-flame-outer' }],
    ['path', { d: 'M12.1 11.2c.5 1.9 2.7 2.9 2.7 5.2a2.8 2.8 0 0 1-5.6 0c0-1.4.7-2.4 1.6-3.1.1.9.5 1.5 1 1.7-.3-1.4-.2-2.6.3-3.8Z', class: 'i-flame-inner' }],
  ],
  flameBroken: [
    ['path', { d: 'M12 1.8c.9 3.6 5.6 5.9 5.6 11.4A5.6 5.6 0 0 1 6.4 13.2c0-2.6 1.2-4.4 2.7-5.8.1 2.1 1 3.4 2.3 3.9-.8-3.4-.3-6.4.6-9.5Z', class: 'i-flame-dead' }],
    ['path', { d: 'M13.5 6 10.8 11l2.6 1.4-2.3 5.6', class: 'i-crack' }],
  ],
  star: [['path', { d: 'm12 2 2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 16.9l-6.1 3.5 1.5-6.8L2.2 9l6.9-.7Z' }]],
  bolt: [['path', { d: 'M13.5 1.5 4 13.5h6.5L9.5 22.5 20 9.5h-6.6Z' }]],
  trophy: [
    ['path', { d: 'M6.5 3h11v5.5a5.5 5.5 0 0 1-11 0Z' }],
    ['path', { d: 'M6.5 4.5H3.5v2a3.5 3.5 0 0 0 3.6 3.5M17.5 4.5h3v2a3.5 3.5 0 0 1-3.6 3.5', class: 'i-stroke' }],
    ['path', { d: 'M10.5 13.8h3v3.4h-3Z' }],
    ['path', { d: 'M7.5 17.5h9a1 1 0 0 1 1 1V21h-11v-2.5a1 1 0 0 1 1-1Z' }],
  ],
  target: [
    ['circle', { cx: 12, cy: 12, r: 9.5, class: 'i-ring' }],
    ['circle', { cx: 12, cy: 12, r: 5.5, class: 'i-ring' }],
    ['circle', { cx: 12, cy: 12, r: 2 }],
  ],
  medal: [
    ['path', { d: 'M7 2h4l2 6H9ZM13 2h4l-2 6h-4Z', class: 'i-ribbon' }],
    ['circle', { cx: 12, cy: 15, r: 6.5 }],
    ['path', { d: 'm12 11.6 1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3Z', class: 'i-medal-star' }],
  ],
  rocket: [
    ['path', { d: 'M12 2c3.6 2.4 5 6.2 4.4 11.2L14 15.5h-4l-2.4-2.3C7 8.2 8.4 4.4 12 2Z' }],
    ['circle', { cx: 12, cy: 8.8, r: 1.8, class: 'i-window' }],
    ['path', { d: 'M7.6 13.2 5 16.6l3.2.4M16.4 13.2l2.6 3.4-3.2.4M10.5 17.5h3l-1.5 4.5Z' }],
  ],
  crown: [['path', { d: 'm2.5 7.5 5 4.5L12 4l4.5 8 5-4.5-2 12h-15ZM4.8 21h14.4' }]],
  shield: [['path', { d: 'm12 1.8 8.5 3.2v6.4c0 5.3-3.6 9.3-8.5 11-4.9-1.7-8.5-5.7-8.5-11V5Z' }]],
  lock: [
    ['path', { d: 'M8 10.5V7.5a4 4 0 0 1 8 0v3', class: 'i-stroke' }],
    ['rect', { x: 5.5, y: 10.5, width: 13, height: 10, rx: 2 }],
  ],
  check: [['path', { d: 'M5 12.5 9.8 17 19 7', class: 'i-stroke' }]],
  cross: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11', class: 'i-stroke' }]],
  rank: [['path', { d: 'M3 17.5 9 11.5l4 4 8-8M15 7.5h6v6', class: 'i-stroke' }]],
};

export function icon(name, { size = 24, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon icon-${name} ${className}`.trim());
  for (const [tag, attrs] of ICONS[name] ?? ICONS.star) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

// A large check or cross inside a ring; CSS draws the strokes in.
export function resultMark(correct) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('class', `fx-mark-svg ${correct ? 'is-correct' : 'is-incorrect'}`);
  svg.setAttribute('aria-hidden', 'true');
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', '60');
  ring.setAttribute('cy', '60');
  ring.setAttribute('r', '52');
  ring.setAttribute('class', 'fx-mark-ring');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', correct ? 'M34 62 52 80 88 42' : 'M40 40 80 80M80 40 40 80');
  path.setAttribute('class', 'fx-mark-path');
  svg.append(ring, path);
  return svg;
}
