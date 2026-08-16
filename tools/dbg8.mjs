import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: false,
  executablePath: '/Users/clawd/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] });
const page = await browser.newPage();
page.on('console', m => console.log('[' + m.type() + ']', m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:8127/spike.html');
await page.click('#t0');
await page.waitForTimeout(8000);
console.log('r0:', await page.$eval('#r0', el => el.innerText));
await browser.close();
