import { reducedMotion } from './motion.js';

const COLORS = ['#ffc83d', '#22c55e', '#3b82f6', '#ec4899', '#a855f7', '#f97316', '#ffffff'];

// Fires a burst of confetti on a full-screen canvas inside `host`, then removes it.
export function confetti(host, { count = 140, originX = 0.5, originY = 0.35, spread = 1, duration = 2600 } = {}) {
  if (reducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  };
  resize();
  const w = () => canvas.width;
  const hgt = () => canvas.height;
  const pieces = Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = (6 + Math.random() * 12) * spread * dpr;
    return {
      x: originX * w(),
      y: originY * hgt(),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 9 * dpr,
      size: (6 + Math.random() * 7) * dpr,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      shape: Math.random() < 0.3 ? 'circle' : 'rect',
    };
  });
  const start = performance.now();
  const frame = (now) => {
    const elapsed = now - start;
    ctx.clearRect(0, 0, w(), hgt());
    const fade = Math.max(0, 1 - Math.max(0, elapsed - duration * 0.6) / (duration * 0.4));
    for (const p of pieces) {
      p.vy += 0.42 * dpr;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
      ctx.restore();
    }
    if (elapsed < duration && canvas.isConnected) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
