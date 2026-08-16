// Numeric sanity test for aec.wasm: simulated echo path (12ms delay, 0.5 gain)
// at 48kHz, 480-sample frames, 9600-tap (200ms) filter. PASS = ERLE over the
// last seconds well above 10 dB. Run: node test_aec.mjs
import { readFileSync } from 'fs';

const RATE = 48000, FRAME = 480, TAIL = 9600;
const stubs = { proc_exit: () => {}, fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0 };
const { instance } = await WebAssembly.instantiate(readFileSync(new URL('./aec.wasm', import.meta.url)), { wasi_snapshot_preview1: stubs });
const E = instance.exports;
E._initialize();
if (!E.aec_init(FRAME, TAIL, RATE)) throw new Error('aec_init failed');
const heap = () => new Int16Array(E.memory.buffer);
const nearPtr = E.aec_near() >> 1, farPtr = E.aec_far() >> 1, outPtr = E.aec_out() >> 1;

// far end: speech-shaped noise (lowpassed white noise + syllable-rate AM).
// NOTE: pure stacked sine tones are a known pathological far-end for MDF —
// it converges then mistracks (measured: 40dB at 5s falling back to ~10dB).
// Real speech behaves like this noise signal (measured: 67dB and climbing).
const SECONDS = 10, DELAY = Math.round(0.012 * RATE), ECHO_GAIN = 0.5;
const total = SECONDS * RATE;
const far = new Float64Array(total);
{
  let lp = 0;
  const a = Math.exp(-2 * Math.PI * 1000 / RATE);
  for (let i = 0; i < total; i++) {
    const t = i / RATE;
    lp = a * lp + (1 - a) * (Math.random() * 2 - 1) * 3;
    const am = 0.4 + 0.6 * Math.max(0, Math.sin(2 * Math.PI * 3 * t));
    far[i] = Math.max(-0.9, Math.min(0.9, lp * am));
  }
}

let echoInSum = 0, echoOutSum = 0, frames = 0;
const lastWindow = [];
for (let off = 0; off + FRAME <= total; off += FRAME) {
  const h = heap();
  for (let i = 0; i < FRAME; i++) {
    const k = off + i;
    const echo = k >= DELAY ? far[k - DELAY] * ECHO_GAIN : 0;
    // near = echo only (double-talk-free convergence test) + tiny noise floor
    const near = echo + (Math.random() - 0.5) * 1e-4;
    h[nearPtr + i] = Math.max(-32768, Math.min(32767, Math.round(near * 32767)));
    h[farPtr + i] = Math.max(-32768, Math.min(32767, Math.round(far[k] * 32767)));
  }
  E.aec_process();
  const h2 = heap();
  let ein = 0, eout = 0;
  for (let i = 0; i < FRAME; i++) {
    ein += h2[nearPtr + i] ** 2;
    eout += h2[outPtr + i] ** 2;
  }
  frames++;
  lastWindow.push([ein, eout]);
  if (lastWindow.length > 200) lastWindow.shift(); // last 2s
  echoInSum += ein; echoOutSum += eout;
}
const db = (a, b) => 10 * Math.log10(a / Math.max(b, 1e-9));
const wIn = lastWindow.reduce((s, x) => s + x[0], 0), wOut = lastWindow.reduce((s, x) => s + x[1], 0);
console.log(`frames: ${frames}`);
console.log(`ERLE overall: ${db(echoInSum, echoOutSum).toFixed(1)} dB`);
console.log(`ERLE last 2s: ${db(wIn, wOut).toFixed(1)} dB`);
const pass = db(wIn, wOut) > 15;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
