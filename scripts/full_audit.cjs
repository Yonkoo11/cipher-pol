const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('file:///Users/yonko/Projects/wraith-protocol/docs/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const positions = [0, 900, 1800, 2700, 3600, 4500, 5400, 6300];
  for (let i = 0; i < positions.length; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), positions[i]);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `/tmp/audit-${i}.png` });
    console.log(`captured y=${positions[i]}`);
  }

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
