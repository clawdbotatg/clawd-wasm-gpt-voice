import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: false,
  executablePath: '/Users/clawd/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8127/');
const out = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const adv = async ctx => { const t = ctx.currentTime; await sleep(400); return +(ctx.currentTime - t).toFixed(3); };
  const r = {};
  // B alone with a local graph
  const solo = new AudioContext({ sampleRate: 48000 });
  const o2 = solo.createOscillator(); o2.connect(solo.createMediaStreamDestination() && solo.destination ? solo.createGain() : null);
  r.solo = await adv(solo); solo.close();
  // A produces a stream; B consumes it
  const A = new AudioContext({ sampleRate: 48000 });
  const oa = A.createOscillator(); const da = A.createMediaStreamDestination();
  oa.connect(da); oa.start();
  const B = new AudioContext({ sampleRate: 48000 });
  await B.resume();
  r.B_before = await adv(B);
  const src = B.createMediaStreamSource(da.stream);
  const sink = B.createMediaStreamDestination();
  src.connect(sink);
  r.B_after_crossctx = await adv(B);
  r.A_state = A.state; r.B_state = B.state;
  return r;
});
console.log(JSON.stringify(out));
await browser.close();
