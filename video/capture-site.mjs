#!/usr/bin/env node
// Captures Cipher Pol website sections as 1920x1080 PNGs for video assembly.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer');
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'site-screenshots');
mkdirSync(OUT, { recursive: true });

const URL = 'https://yonkoo11.github.io/cipher-pol/';

const SHOTS = [
  { name: 'hero',             scrollY: 0,    wait: 2000 },
  { name: 'privacy-contract', scrollY: 1080, wait: 500  },
  { name: 'how-zk-steps',    scrollY: 1809, wait: 500  },
  { name: 'anonymity-set',   scrollY: 2657, wait: 1500 }, // canvas animation
  { name: 'build-sdk',       scrollY: 3463, wait: 500  },
  { name: 'specs',           scrollY: 4091, wait: 500  },
  { name: 'honest-limits',   scrollY: 4891, wait: 500  },
  { name: 'roadmap',         scrollY: 6096, wait: 500  },
];

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  defaultViewport: { width: 1920, height: 1080 },
});

const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
console.log(`Loading ${URL}...`);
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
// Let fonts load
await new Promise(r => setTimeout(r, 2000));

for (const { name, scrollY, wait } of SHOTS) {
  await page.evaluate(y => window.scrollTo(0, y), scrollY);
  await new Promise(r => setTimeout(r, wait));
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, type: 'png' });
  console.log(`  ✓ ${name}.png  (scrollY=${scrollY})`);
}

await browser.close();
console.log(`Done. PNGs saved to ${OUT}/`);
