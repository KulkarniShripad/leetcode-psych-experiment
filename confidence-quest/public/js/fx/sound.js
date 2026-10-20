// Tiny synthesized sound effects (no audio files). Off unless gamification.json turns
// sound on: in a shared room, sounds would tell neighbours which group someone is in.
let audio = null;

function context() {
  if (!audio) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audio = new Ctx();
  }
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

function tone(freq, start, duration, { type = 'sine', gain = 0.12, slideTo = null } = {}) {
  const ctx = context();
  if (!ctx) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export function playCorrect(streak = 1) {
  const notes = [523.25, 659.25, 783.99];
  if (streak >= 3) notes.push(1046.5);
  notes.forEach((f, i) => tone(f, i * 0.08, 0.22, { type: 'triangle' }));
}

export function playIncorrect() {
  tone(220, 0, 0.35, { type: 'sawtooth', gain: 0.06, slideTo: 110 });
}

export function playLevelUp() {
  [392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.35 + i * 0.07, 0.3, { type: 'square', gain: 0.05 }));
}
