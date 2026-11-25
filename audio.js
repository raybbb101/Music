// Plucked-string synth using the Karplus-Strong algorithm.
// Each note is rendered once into an AudioBuffer and cached, so plucking is instant.

export class StringSynth {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.cache = new Map();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;

    // Light body resonance + gentle reverb-ish feedback delay for a warmer guitar feel.
    const body = this.ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 220;
    body.Q.value = 1.2;
    body.gain.value = 4;

    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;

    const delay = this.ctx.createDelay();
    delay.delayTime.value = 0.12;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.22;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.25;
    const tone = this.ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2500;

    this.master.connect(body);
    body.connect(comp);
    body.connect(delay);
    delay.connect(tone);
    tone.connect(fb);
    fb.connect(delay);
    tone.connect(wet);
    wet.connect(comp);
    comp.connect(this.ctx.destination);
  }

  resume() {
    if (this.ctx.state !== 'running') return this.ctx.resume();
  }

  render(freq) {
    const key = Math.round(freq * 10);
    if (this.cache.has(key)) return this.cache.get(key);

    const sr = this.ctx.sampleRate;
    const seconds = 3;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);

    const period = sr / freq;
    const N = Math.max(2, Math.floor(period));
    const frac = period - N; // fractional delay for accurate tuning
    const ring = new Float32Array(N);
    // Noise burst, slightly low-passed so the attack isn't too harsh.
    let prev = 0;
    for (let i = 0; i < N; i++) {
      const r = Math.random() * 2 - 1;
      prev = prev * 0.5 + r * 0.5;
      ring[i] = prev;
    }
    // Lower notes ring longer; higher ones decay faster, like real strings.
    const decay = 0.996 + 0.0035 * Math.min(1, 150 / freq);
    const c = (1 - frac) / (1 + frac); // allpass coefficient for fine tuning
    let ap = 0, apIn = 0, idx = 0;
    for (let i = 0; i < len; i++) {
      const cur = ring[idx];
      const next = ring[(idx + 1) % N];
      const avg = decay * 0.5 * (cur + next);
      // first-order allpass for fractional delay
      const y = c * avg + apIn - c * ap;
      apIn = avg; ap = y;
      ring[idx] = y;
      out[i] = cur;
      idx = (idx + 1) % N;
    }
    // Short fade out at the end to avoid a click.
    const fade = Math.floor(sr * 0.05);
    for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade;

    this.cache.set(key, buf);
    return buf;
  }

  pluck(freq, velocity = 1, pan = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.render(freq);
    const g = this.ctx.createGain();
    g.gain.value = 0.35 + 0.65 * Math.min(1, velocity);
    let node = g;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      node = p;
    }
    src.connect(g);
    node.connect(this.master);
    src.start();
  }
}

// Pentatonic scale so any set of strings sounds good together.
const PENTA = [0, 2, 4, 7, 9]; // major pentatonic semitone offsets
const BASE_MIDI = 40; // E2 — lowest guitar string
const OCTAVES = 3;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const SCALE = [];
for (let o = 0; o < OCTAVES; o++) for (const s of PENTA) SCALE.push(BASE_MIDI + o * 12 + s);
SCALE.push(BASE_MIDI + OCTAVES * 12);

// t in [0,1]: 0 = shortest line (lowest note), 1 = longest line (highest note).
export function noteForLength(t) {
  const i = Math.round(Math.max(0, Math.min(1, t)) * (SCALE.length - 1));
  const midi = SCALE[i];
  return {
    midi,
    freq: 440 * Math.pow(2, (midi - 69) / 12),
    name: NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1),
  };
}
