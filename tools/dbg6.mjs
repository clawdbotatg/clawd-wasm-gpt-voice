import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: false,
  executablePath: '/Users/clawd/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
         '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8127/');
const out = await page.evaluate(async () => {
  const res = [];
  const t = (name, p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 4000))])
    .then(s => { res.push(name + ' ok: ' + s.getAudioTracks()[0].label); s.getTracks().forEach(x => x.stop()); })
    .catch(e => res.push(name + ' FAIL: ' + e.message));
  await t('plain', navigator.mediaDevices.getUserMedia({ audio: true }));
  await t('ec-false', navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false } }));
  await t('full', navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }));
  return res;
});
console.log(out);
await browser.close();
