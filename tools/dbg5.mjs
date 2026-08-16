import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: false,
  executablePath: '/Users/clawd/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
         '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8127/');
const out = await page.evaluate(async () => {
  const steps = [];
  const t = (name, p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT ' + name)), 5000))])
    .then(v => { steps.push(name + ' ok'); return v; })
    .catch(e => { steps.push(name + ' FAIL: ' + e.message); throw e; });
  try {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await t('resume', ctx.resume());
    const wasmBytes = await t('wasm fetch', fetch('/aec/aec.wasm').then(r => r.arrayBuffer()));
    await t('addModule', ctx.audioWorklet.addModule('/aec/aec-worklet.js'));
    const mic = await t('gum', navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: false, noiseSuppression: true, autoGainControl: true } }));
    steps.push('mic label: ' + mic.getAudioTracks()[0].label);
    const node = new AudioWorkletNode(ctx, 'aec-processor', {
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { wasmBytes, tailMs: 200 } });
    steps.push('node ok');
  } catch (e) { steps.push('aborted: ' + e.message); }
  return steps;
});
console.log(out);
await browser.close();
