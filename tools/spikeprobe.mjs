// Drive spike.html in a local Chromium with the REAL mic + speakers.
// Headed (not headless) so audio actually reaches the Mac's output device.
// Usage: node tools/spikeprobe.mjs [--url http://127.0.0.1:8127/spike.html] [--t1-only]
import { chromium } from 'playwright-core';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:8127/spike.html';
const t1Only = process.argv.includes('--t1-only');

const browser = await chromium.launch({
  headless: false,
  executablePath: '/Users/clawd/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: [
    '--use-fake-ui-for-media-stream',            // auto-grant mic (still the real device)
    '--autoplay-policy=no-user-gesture-required',
    ...(process.argv.includes('--no-audio-out') ? ['--disable-audio-output'] : []),
  ],
});
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('console.error:', m.text()); });
await page.goto(url);

console.log('== test 0: synthetic pipeline ==');
await page.click('#t0');
await page.waitForFunction(() => document.getElementById('r0').innerText.includes('TEST 0:'), { timeout: 60000 });
console.log(await page.$eval('#r0', el => el.innerText));

console.log('== test 1: remote track tap ==');
await page.click('#t1');
await page.waitForFunction(() => document.getElementById('r1').innerText.includes('TEST 1:'), { timeout: 30000 });
console.log(await page.$eval('#r1', el => el.innerText));

if (!t1Only) {
  console.log('== test 2: speaker echo cancellation (~25s, audible) ==');
  await page.click('#t2');
  await page.waitForFunction(() => document.getElementById('r2').innerText.includes('TEST 2:'), { timeout: 60000 });
  console.log(await page.$eval('#r2', el => el.innerText));
}
await browser.close();
