// Drives the real index.html demo with stubbed network/WebRTC in a local
// Chromium (null audio sink — works even when system CoreAudio is wedged).
// Asserts, for the WASM-AEC path:
//   1. session reaches "live" with the AEC line showing "on"
//   2. the track handed to pc.addTrack is the worklet's cleaned output,
//      NOT the raw mic track
//   3. the remote track gets tapped into the worklet's reference input
//   4. worklet stats flow (AEC line shows "cancelling N dB")
// and for the fallback: blocking aec.wasm still yields a live session with
// the browser-AEC mic track.
// Usage: node tools/demoprobe.mjs [--url http://127.0.0.1:8127/]
import { chromium } from 'playwright-core';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:8127/';

const EXE = '/Users/clawd/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const STUBS = `
  window.__probe = { added: [], taps: 0, remoteStreams: 0 };
  // fake mic: system CoreAudio may be wedged (real capture hangs), so hand the
  // app a synthetic tone stream and mark its track so assertions can tell the
  // raw "mic" track from the worklet's cleaned output track.
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new (window.AudioContext)({ sampleRate: 48000 });
    const osc = ctx.createOscillator(); osc.frequency.value = 220;
    const g = ctx.createGain(); g.gain.value = 0.3;
    const d = ctx.createMediaStreamDestination();
    osc.connect(g).connect(d); osc.start();
    d.stream.getAudioTracks()[0].__fakeMic = true;
    return d.stream;
  };
  // fake WebRTC: records what the app sends, hands back a synthetic remote track
  class FakePC {
    constructor() { this.connectionState = 'new'; }
    addTrack(t, s) { window.__probe.added.push({ label: t.label, kind: t.kind, id: t.id, fakeMic: !!t.__fakeMic }); }
    createDataChannel() { return { send: () => {}, close: () => {}, readyState: 'open' }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0 fake' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {
      const ctx = new (window.AudioContext)({ sampleRate: 48000 });
      const osc = ctx.createOscillator(); osc.frequency.value = 330;
      const g = ctx.createGain(); g.gain.value = 0.4;
      const d = ctx.createMediaStreamDestination();
      osc.connect(g).connect(d); osc.start();
      window.__probe.remoteStreams++;
      const stream = d.stream;
      const origGetTracks = stream.getAudioTracks.bind(stream);
      this.ontrack && this.ontrack({ streams: [stream] });
    }
    close() {}
  }
  window.RTCPeerConnection = FakePC;
  // count reference-tap connects: any MediaStreamSource created on a stream
  // AFTER the session's remote stream exists and connected with (0,1)
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (...args) {
    if (args.length === 3 && args[1] === 0 && args[2] === 1) window.__probe.taps++;
    return origConnect.apply(this, args);
  };
  // capture the app's worklet node + count its port messages
  const OrigAWN = window.AudioWorkletNode;
  window.AudioWorkletNode = function (ctx, name, opts) {
    const n = new OrigAWN(ctx, name, opts);
    window.__probe.awn = true;
    window.__probe.awnCtx = ctx;
    n.port.addEventListener('message', e => {
      window.__probe.msgs = (window.__probe.msgs || 0) + 1;
      window.__probe.lastMsg = e.data && e.data.type;
    });
    return n;
  };
  // fake token + SDP answer; everything else passes through
  const origFetch = window.fetch;
  window.fetch = (input, init) => {
    const u = String(input);
    if (u.endsWith('/token')) return Promise.resolve(new Response(JSON.stringify({ value: 'ek_test' })));
    if (u.includes('api.openai.com/v1/realtime/calls'))
      return Promise.resolve(new Response('v=0 fake-answer', { status: 200 }));
    if (u.includes('api.coingecko.com')) return Promise.resolve(new Response('{}'));
    return origFetch(input, init);
  };
`;

async function run(label, { blockWasm }) {
  const browser = await chromium.launch({ headless: false, executablePath: EXE,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
           '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (blockWasm) await page.route('**/aec/aec.wasm', r => r.abort());
  await page.addInitScript(STUBS);
  await page.goto(url);
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.check('#wasmaec');
  await page.click('#btn');
  try {
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('live'), { timeout: 20000 });
  } catch (e) {
    console.log('TIMEOUT; status:', await page.$eval('#status', el => el.textContent));
    console.log('log:', await page.$eval('#log', el => el.innerText));
    console.log('aecline:', await page.$eval('#aecline', el => el.textContent));
    console.log('pageerrors:', errors);
    await browser.close();
    throw e;
  }
  await page.waitForTimeout(4000); // let stats tick
  const state = await page.evaluate(async () => ({
    probe: (() => { const { awnCtx, ...rest } = window.__probe; return rest; })(),
    ctx: window.__probe.awnCtx ? {
      state: window.__probe.awnCtx.state,
      t0: window.__probe.awnCtx.currentTime,
      t1: await new Promise(r => setTimeout(() => r(window.__probe.awnCtx.currentTime), 300)),
    } : null,
    aecLine: document.getElementById('aecline').textContent,
    aecVisible: document.getElementById('aecline').style.display !== 'none',
    status: document.getElementById('status').textContent,
    log: document.getElementById('log').innerText.slice(0, 500),
  }));
  await browser.close();
  console.log(`-- ${label} --`);
  console.log(JSON.stringify({ ...state, errors }, null, 1));
  return state;
}

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; };

const a = await run('wasm aec path', { blockWasm: false });
ok(a.status.includes('live'), 'session live');
ok(a.probe.added.length === 1, 'exactly one track sent');
ok(a.probe.added[0] && !a.probe.added[0].fakeMic, 'sent track is NOT the raw mic track');
ok(a.probe.taps >= 1, 'remote track tapped into worklet reference input');
ok(/cancelling|on/.test(a.aecLine) && a.aecVisible, 'AEC line active: ' + a.aecLine);
ok(a.probe.msgs >= 1 && a.probe.lastMsg, 'worklet instantiated wasm (got "' + a.probe.lastMsg + '")');
if (a.ctx && a.ctx.t1 > a.ctx.t0) {
  ok(/cancelling -?\d+ dB/.test(a.aecLine), 'worklet stats flowing: ' + a.aecLine);
} else {
  console.log('WARN worklet stats not checked — app AudioContext clock frozen (broken/fake audio backend on this machine); spike test 0 covers this on healthy audio');
}

const b = await run('fallback (wasm blocked)', { blockWasm: true });
ok(b.status.includes('live'), 'fallback session live');
ok(b.probe.added[0] && b.probe.added[0].fakeMic, 'fallback sends the raw mic track');
ok(/fallback/.test(b.aecLine), 'AEC line shows fallback: ' + b.aecLine);

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
