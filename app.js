import { FilesetResolver, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { StringSynth, noteForLength } from './audio.js';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Tuning
const PINCH_ON = 0.33;   // thumb-index distance / palm size to start a pinch
const PINCH_OFF = 0.48;  // ...and to release it (hysteresis prevents flicker)
const RELEASE_GRACE_MS = 140; // tolerate brief tracking dropouts while drawing
const MIN_STRING_PX = 50;     // ignore accidental tiny strings
const PLUCK_COOLDOWN_MS = 160;
const MAX_STRINGS = 24;

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const startBtn = $('startBtn');
const statusEl = $('status');
const hint = $('hint');

let W = 0, H = 0, DPR = 1;
let synth = null;
let landmarker = null;
let running = false;
let lastVideoTime = -1;

/** @type {{a:{x:number,y:number}, b:{x:number,y:number}, t:number, freq:number, name:string, hue:number, amp:number, phase:number, lastPluck:number}[]} */
let strings = [];          // endpoints stored as fractions of the screen (0..1)
const handState = new Map(); // per-hand: pinching, smoothed pinch point, previous fingertip
let draft = null;          // line being drawn {a, b} in px
let draftLostAt = 0;

// ---------- layout ----------
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// Map a normalized landmark to screen px, matching the mirrored, object-fit: cover video.
function toScreen(lm) {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const s = Math.max(W / vw, H / vh);
  const dw = vw * s, dh = vh * s;
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  return { x: W - (ox + lm.x * dw), y: oy + lm.y * dh };
}

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const lerp = (a, b, k) => a + (b - a) * k;

function lengthToT(len) {
  const minL = MIN_STRING_PX;
  const maxL = Math.hypot(W, H) * 0.7;
  return Math.max(0, Math.min(1, (len - minL) / (maxL - minL)));
}

// ---------- strings ----------
function addString(a, b) {
  const len = dist(a, b);
  if (len < MIN_STRING_PX) return;
  const t = lengthToT(len);
  const note = noteForLength(t);
  strings.push({
    a: { x: a.x / W, y: a.y / H }, b: { x: b.x / W, y: b.y / H },
    t, freq: note.freq, name: note.name, hue: 30 + t * 250,
    amp: 0, phase: 0, lastPluck: 0,
  });
  if (strings.length > MAX_STRINGS) strings.shift();
  save();
  pluck(strings[strings.length - 1], 0.6, (a.x + b.x) / 2);
}

function pluck(s, velocity, atX) {
  const now = performance.now();
  if (now - s.lastPluck < PLUCK_COOLDOWN_MS) return;
  s.lastPluck = now;
  s.amp = Math.min(22, 8 + velocity * 16);
  if (synth) synth.pluck(s.freq, velocity, (atX / W) * 2 - 1);
}

// Segment intersection test (p1->p2 crosses q1->q2)
function crosses(p1, p2, q1, q2) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(q1, q2, p1), d2 = d(q1, q2, p2), d3 = d(p1, p2, q1), d4 = d(p1, p2, q2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function strum(prev, cur, dt) {
  const move = dist(prev, cur);
  if (move < 2 || move > Math.max(W, H) * 0.35) return; // ignore jitter & tracking jumps
  const speed = move / Math.max(dt, 1); // px per ms
  const velocity = Math.min(1, speed / 2.5);
  for (const s of strings) {
    const a = { x: s.a.x * W, y: s.a.y * H }, b = { x: s.b.x * W, y: s.b.y * H };
    if (crosses(prev, cur, a, b)) pluck(s, Math.max(0.25, velocity), cur.x);
  }
}

// ---------- persistence ----------
function save() {
  try { localStorage.setItem('air-strings', JSON.stringify(strings.map(({ a, b, t }) => ({ a, b, t })))); } catch {}
}
function load() {
  try {
    const data = JSON.parse(localStorage.getItem('air-strings') || '[]');
    strings = data.map(({ a, b, t }) => {
      const n = noteForLength(t);
      return { a, b, t, freq: n.freq, name: n.name, hue: 30 + t * 250, amp: 0, phase: 0, lastPluck: 0 };
    });
  } catch { strings = []; }
}

// ---------- hand processing ----------
function processHands(result, now) {
  const hands = result.landmarks || [];
  const seen = new Set();
  const pinchPoints = [];

  hands.forEach((lm, i) => {
    const label = result.handedness?.[i]?.[0]?.categoryName || 'H';
    let key = label;
    if (seen.has(key)) key = label + i;
    seen.add(key);

    const thumb = toScreen(lm[4]);
    const index = toScreen(lm[8]);
    const palm = dist(toScreen(lm[0]), toScreen(lm[9])) || 1;
    const ratio = dist(thumb, index) / palm;

    let st = handState.get(key);
    if (!st) { st = { pinching: false, point: null, tip: null, tipTime: 0, lastSeen: 0 }; handState.set(key, st); }
    st.lastSeen = now;

    if (!st.pinching && ratio < PINCH_ON) st.pinching = true;
    else if (st.pinching && ratio > PINCH_OFF) st.pinching = false;

    const mid = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
    st.point = st.point ? { x: lerp(st.point.x, mid.x, 0.55), y: lerp(st.point.y, mid.y, 0.55) } : mid;

    // Strumming with the index fingertip when this hand is not pinching.
    if (!st.pinching && !draft && st.tip) strum(st.tip, index, now - st.tipTime);
    st.tip = index; st.tipTime = now;
    st.lm = lm;

    if (st.pinching) pinchPoints.push(st.point);
  });

  // Forget hands that disappeared so a returning hand doesn't "teleport-strum".
  for (const [k, st] of handState) if (now - st.lastSeen > 300) handState.delete(k);
  for (const [k, st] of handState) if (!seen.has(k)) { st.tip = null; st.lm = null; st.pinching = false; }

  // Two-hand pinch → draw a line; release → keep it.
  if (pinchPoints.length >= 2) {
    draft = { a: pinchPoints[0], b: pinchPoints[1] };
    draftLostAt = 0;
  } else if (draft) {
    if (!draftLostAt) draftLostAt = now;
    if (now - draftLostAt > RELEASE_GRACE_MS) {
      addString(draft.a, draft.b);
      draft = null; draftLostAt = 0;
    }
  }

  return hands.length;
}

// ---------- drawing ----------
function drawString(a, b, hue, amp, phase, alpha = 1, width = 3) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const steps = 40;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const off = amp * Math.sin(Math.PI * u) * Math.sin(phase);
    const x = a.x + dx * u + nx * off, y = a.y + dy * u + ny * off;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = `hsla(${hue}, 95%, 65%, ${alpha})`;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.shadowColor = `hsla(${hue}, 100%, 60%, ${0.8 * alpha})`;
  ctx.shadowBlur = 12 + amp;
  ctx.stroke();
  ctx.shadowBlur = 0;
  for (const p of [a, b]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue}, 90%, 80%, ${alpha})`;
    ctx.fill();
  }
}

const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function drawHands() {
  for (const st of handState.values()) {
    if (!st.lm) continue;
    const pts = st.lm.map(toScreen);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [i, j] of BONES) { ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); }
    ctx.stroke();
    if (st.pinching) {
      ctx.beginPath();
      ctx.arc(st.point.x, st.point.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,179,71,0.9)';
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(pts[8].x, pts[8].y, 8, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function render(dt) {
  ctx.clearRect(0, 0, W, H);

  for (const s of strings) {
    s.phase += dt * 0.09;
    s.amp *= Math.pow(0.04, dt / 1000);
    if (s.amp < 0.05) s.amp = 0;
    const a = { x: s.a.x * W, y: s.a.y * H }, b = { x: s.b.x * W, y: s.b.y * H };
    drawString(a, b, s.hue, s.amp, s.phase, 1, 2 + (1 - s.t) * 3);
    if (s.amp > 1) {
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillStyle = `hsla(${s.hue}, 90%, 85%, ${Math.min(1, s.amp / 8)})`;
      ctx.textAlign = 'center';
      ctx.fillText(s.name, (a.x + b.x) / 2, (a.y + b.y) / 2 - 14);
    }
  }

  if (draft) {
    const len = dist(draft.a, draft.b);
    const t = lengthToT(len);
    const n = noteForLength(t);
    const ok = len >= MIN_STRING_PX;
    ctx.setLineDash([10, 8]);
    drawString(draft.a, draft.b, 30 + t * 250, 0, 0, ok ? 0.9 : 0.35, 3);
    ctx.setLineDash([]);
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(ok ? n.name : 'too short', (draft.a.x + draft.b.x) / 2, (draft.a.y + draft.b.y) / 2 - 18);
  }

  drawHands();
}

// ---------- main loop ----------
let lastFrame = performance.now();
let lastHint = '';
function setHint(text) {
  if (text === lastHint) return;
  lastHint = text; hint.textContent = text; hint.hidden = !text;
}

function loop() {
  if (!running) return;
  const now = performance.now();
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;

  let handCount = 0;
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = landmarker.detectForVideo(video, now);
    handCount = processHands(result, now);
    if (draft) setHint('Release the pinch to keep the string');
    else if (handCount === 0) setHint('Show your hands to the camera');
    else if (handCount === 1 && !strings.length) setHint('Pinch with BOTH hands to draw a string');
    else if (strings.length) setHint('Swipe your index finger across a string to play');
    else setHint('Pinch thumb + index on both hands');
  }

  render(dt);
  requestAnimationFrame(loop);
}

// Mouse / touch strumming too, handy without a camera angle or for testing.
let pointerPrev = null, pointerTime = 0;
canvas.addEventListener('pointerdown', (e) => { synth?.resume(); pointerPrev = { x: e.clientX, y: e.clientY }; pointerTime = performance.now(); });
canvas.addEventListener('pointermove', (e) => {
  if (!pointerPrev) return;
  const cur = { x: e.clientX, y: e.clientY }, now = performance.now();
  strum(pointerPrev, cur, now - pointerTime);
  pointerPrev = cur; pointerTime = now;
});
window.addEventListener('pointerup', () => { pointerPrev = null; });

// ---------- startup ----------
async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { return await HandLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch { return await HandLandmarker.createFromOptions(fileset, opts('CPU')); }
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    synth = synth || new StringSynth();
    await synth.resume();

    statusEl.textContent = 'Asking for camera permission…';
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera (use Chrome over https or localhost).');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play();

    statusEl.textContent = 'Loading hand tracking…';
    landmarker = landmarker || await createLandmarker();

    $('intro').hidden = true;
    $('toolbar').hidden = false;
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    statusEl.textContent = err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow it in the address bar and try again.'
      : `Could not start: ${err.message || err}`;
    startBtn.disabled = false;
  }
});

$('undoBtn').addEventListener('click', () => { strings.pop(); save(); });
$('clearBtn').addEventListener('click', () => { strings = []; save(); });

// Install prompt (Chrome)
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e; $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null; $('installBtn').hidden = true;
});
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

load();
render(0);
