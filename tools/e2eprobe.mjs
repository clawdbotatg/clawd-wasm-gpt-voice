// E2E against REAL OpenAI: real token mint, real SDP exchange, real remote
// track — only getUserMedia is stubbed (synthetic tone; this Mac's CoreAudio
// is wedged so real capture hangs). Null audio sink. Costs a few cents.
// Asserts: session live, worklet wasm ready, remote track arrived and got
// tapped into the reference input, no page errors.
// Usage: node tools/e2eprobe.mjs [--url http://127.0.0.1:8127/]
import { chromium } from 'playwright-core';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:8127/';
const EXE = '/Users/clawd/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const browser = await chromium.launch({ headless: false, executablePath: EXE,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(`
  window.__probe = { taps: 0, remoteTracks: 0, msgs: 0 };
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const osc = ctx.createOscillator(); osc.frequency.value = 220;
    const g = ctx.createGain(); g.gain.value = 0.2;
    const d = ctx.createMediaStreamDestination();
    osc.connect(g).connect(d); osc.start();
    return d.stream;
  };
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new OrigPC(...a);
    window.__probe.pc = pc;
    pc.addEventListener('track', () => window.__probe.remoteTracks++);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (...args) {
    if (args.length === 3 && args[1] === 0 && args[2] === 1) window.__probe.taps++;
    return origConnect.apply(this, args);
  };
  const OrigAWN = window.AudioWorkletNode;
  window.AudioWorkletNode = function (ctx, name, opts) {
    const n = new OrigAWN(ctx, name, opts);
    n.port.addEventListener('message', e => {
      window.__probe.msgs++;
      if (e.data && e.data.type === 'ready') window.__probe.wasmReady = true;
      if (e.data && e.data.type === 'stats' && e.data.erleDb != null) window.__probe.sawErle = true;
    });
    return n;
  };
`);
await page.goto(url);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.check('#wasmaec');
// cheapest model for a probe call
await page.selectOption('#model', 'gpt-realtime-mini');
await page.click('#btn');
try {
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('live'), { timeout: 30000 });
} catch (e) {
  console.log('TIMEOUT; status:', await page.$eval('#status', el => el.textContent));
  console.log('log:', await page.$eval('#log', el => el.innerText));
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(8000);
const state = await page.evaluate(() => ({
  taps: window.__probe.taps,
  remoteTracks: window.__probe.remoteTracks,
  wasmReady: !!window.__probe.wasmReady,
  sawErle: !!window.__probe.sawErle,
  msgs: window.__probe.msgs,
  pcState: window.__probe.pc && window.__probe.pc.connectionState,
  status: document.getElementById('status').textContent,
  aecLine: document.getElementById('aecline').textContent,
  log: document.getElementById('log').innerText.slice(0, 800),
}));
await page.click('#btn'); // stop — don't leave a billed session running
await page.waitForTimeout(500);
await browser.close();
console.log(JSON.stringify({ ...state, errors }, null, 1));
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
ok(state.status.includes('live'), 'session reached live against real OpenAI');
ok(state.pcState === 'connected', 'peer connection connected (state: ' + state.pcState + ')');
ok(state.remoteTracks >= 1, 'real remote track arrived');
ok(state.wasmReady, 'wasm canceller instantiated in worklet');
ok(state.taps >= 1, 'remote track tapped into reference input');
ok(errors.length === 0, 'no page errors');
console.log(fail ? fail + ' FAILURES' : 'ALL PASS');
process.exit(fail ? 1 : 0);
