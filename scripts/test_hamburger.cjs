const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('file:///Users/yonko/Projects/wraith-protocol/docs/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  await page.screenshot({ path: '/tmp/nav-closed.png' });
  console.log('nav closed captured');

  await page.click('.nav-hamburger');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/nav-open.png' });
  console.log('nav open captured');

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
