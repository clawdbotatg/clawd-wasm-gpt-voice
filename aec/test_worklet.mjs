// Drives the REAL aec-worklet.js in Node with AudioWorklet shims, through the
// scenario that broke on the iPhone: converge on a 50ms echo, take a discrete
// delay jump to 120ms (an iOS route/pipeline change), then a delay-tracker
// shift + filter reset. PASS = it re-converges after the shift.
// Run: node aec/test_worklet.mjs
import { readFileSync } from 'fs';
const RATE = 48000;
globalThis.sampleRate = RATE;
globalThis.currentTime = 0;
const posted = [];
let PROC;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; }
};
globalThis.registerProcessor = (name, cls) => { PROC = cls; };
await import(new URL('./aec-worklet.js', import.meta.url));

const wasmBytes = readFileSync(new URL('./aec.wasm', import.meta.url));
const p = new PROC({ processorOptions: { wasmBytes, tailMs: 200 } });
while (!p.ready) await new Promise(r => setTimeout(r, 10));

const SEC = 16, total = SEC * RATE;
const far = new Float64Array(total);
let lp = 0; const a = Math.exp(-2 * Math.PI * 1000 / RATE);
for (let i = 0; i < total; i++) {
  const t = i / RATE;
  lp = a * lp + (1 - a) * (Math.random() * 2 - 1) * 3;
  far[i] = Math.max(-0.9, Math.min(0.9, lp * (0.4 + 0.6 * Math.max(0, Math.sin(2 * Math.PI * 3 * t)))));
}
const d1 = Math.round(0.05 * RATE), d2 = Math.round(0.12 * RATE);
const Q = 128;
const nearBuf = new Float32Array(Q), farBuf = new Float32Array(Q), outBuf = new Float32Array(Q);
let ein = 0, eout = 0, n = 0, sec = 0;
const per = [];
for (let off = 0; off + Q <= total; off += Q) {
  for (let i = 0; i < Q; i++) {
    const k = off + i;
    const dl = k < 6 * RATE ? d1 : d2;
    nearBuf[i] = k >= dl ? far[k - dl] * 0.5 : 0;
    farBuf[i] = far[k];
  }
  globalThis.currentTime = off / RATE;
  p.process([[nearBuf], [farBuf]], [[outBuf]]);
  for (let i = 0; i < Q; i++) { ein += nearBuf[i] ** 2; eout += outBuf[i] ** 2; }
  n += Q;
  if (n >= RATE) {
    per.push(10 * Math.log10(ein / Math.max(eout, 1e-9)));
    ein = 0; eout = 0; n = 0; sec++;
    // what aec-align.js would command once it sees the ~120ms residual
    if (sec === 9) p.port.onmessage({ data: { type: 'farDelay', ms: 80 } });
  }
}
console.log('ERLE/s:', per.map(x => x.toFixed(1)).join(' '));
console.log('farDelay applied:', (p.farDelay / RATE * 1000).toFixed(0), 'ms;',
  'env msgs:', posted.filter(m => m.type === 'env').length);
const preJump = per[5], postShift = per.slice(-3).reduce((x, y) => x + y, 0) / 3;
console.log(`pre-jump: ${preJump.toFixed(1)} dB   settled after shift: ${postShift.toFixed(1)} dB`);
const pass = preJump > 25 && postShift > 25 && p.farDelay === Math.round(0.08 * RATE);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
