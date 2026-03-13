const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  });
  const page = await browser.newPage();
  
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('file:///Users/yonko/Projects/wraith-protocol/docs/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  
  const result = await page.evaluate(() => {
    const canvas = document.getElementById('hero-canvas');
    const ctx = canvas.getContext('2d');
    const pixel = ctx.getImageData(900, 300, 1, 1).data;
    return { w: canvas.width, h: canvas.height, pixel: Array.from(pixel) };
  });
  
  console.log('Canvas:', result);
  console.log('Errors:', errors);
  
  await page.screenshot({ path: '/tmp/index-debug.png' });
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
