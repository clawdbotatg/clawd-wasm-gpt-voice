import { chromium } from 'playwright-core';
const blockSpeak = process.argv.includes('--noise');
const browser = await chromium.launch({ headless: false,
  executablePath: '/Users/clawd/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
const page = await browser.newPage();
if (blockSpeak) await page.route('**/speak', r => r.abort());
await page.goto('http://127.0.0.1:8127/spike.html');
await page.evaluate(() => { window.__lags = []; AecAlign.onLag = (l, s) => window.__lags.push([l, s]); });
await page.click('#t0');
await page.waitForFunction(() => document.getElementById('r0').innerText.includes('TEST 0:'), { timeout: 40000 });
console.log((blockSpeak ? 'NOISE clip: ' : 'MARIN clip: '));
console.log(await page.$eval('#r0', el => el.innerText));
console.log('aligner estimates [lag,score]:', JSON.stringify(await page.evaluate(() => window.__lags)));
await browser.close();
