const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('file:///Users/yonko/Projects/wraith-protocol/docs/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: '/tmp/hero-merkle.png' });
  console.log('hero captured');
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/sections-reveal.png' });
  console.log('sections captured');
  await page.evaluate(() => window.scrollTo(0, 2500));
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/anon-canvas.png' });
  console.log('anon captured');
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
