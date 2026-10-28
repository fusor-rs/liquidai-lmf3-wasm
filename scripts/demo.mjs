// Records the README's demo, assets/demo/demo.gif: the real page on LFM3-VL-2B, served locally
// with dist/model, in headless Chrome. A first visit loads the bundle into the browser's storage;
// the recorded one loads it from there, adds the receipt of the fixed conversations, asks for its
// total without a thinking block and sends it, then waits for the reply. Chrome's screencast gives
// the frames, ffmpeg (FFMPEG names it) the GIF. The page's footer and tiles show what this machine
// measured; the script prints them.
//
//   FFMPEG=<path> node scripts/demo.mjs    # `just demo` builds the page first and finds ffmpeg
import { chromium } from '../vendor/fusor-ai/packages/e2e/node_modules/playwright/index.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const PORT = 8798;
const PAGE = `http://127.0.0.1:${PORT}/?id=lfm3-vl-2b`;
const IMAGE = join(root, 'fixtures/media/example-receipt.png');
const QUESTION = 'What is the total on this receipt? Answer in one sentence.';
const WIDTH = 980;
const HEIGHT = 700;
const FPS = 12;
const DEADLINE_MS = 10 * 60 * 1000;
// How long the finished reply stays on screen.
const HOLD_MS = 2500;
const OUTPUT = join(root, 'assets/demo/demo.gif');
const step = (message) => console.log(new Date().toISOString().slice(11, 19), message);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A drawn cursor: headless Chrome renders none.
const INSTRUMENT = () => {
  addEventListener('DOMContentLoaded', () => {
    const cursor = document.createElement('div');
    cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2l18 10-8 2.5L9.5 23z" fill="#272a2c" stroke="#faf9f6" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, {
      position: 'fixed', left: '0', top: '0', zIndex: 99, pointerEvents: 'none',
      transform: 'translate(700px, 600px)', transition: 'transform 0.7s cubic-bezier(.2,.8,.2,1)',
    });
    document.body.append(cursor);
    window.moveCursor = (x, y) => (cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`);
  });
};

async function clickOn(page, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const box = await page.locator(selector).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(([cx, cy]) => window.moveCursor(cx, cy), [x, y]);
  await pause(800);
  await page.mouse.click(x, y);
  await pause(250);
}

const loaded = () => document.querySelector('main')?.dataset.loaded === 'true' || document.querySelector('main')?.dataset.phase === 'broken';
const idle = () => /^(idle|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const server = spawn(process.execPath, [join(root, 'vendor/fusor-ai/scripts/serve.mjs'), '--port', String(PORT),
  '--mount', '/=app/dist', '--mount', '/model/=dist/model'], { cwd: root, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'lfm3-demo-'));
const work = mkdtempSync(join(tmpdir(), 'lfm3-demo-frames-'));
try {
  await pause(800);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1,
  });
  step('loading the bundle into the browser storage');
  const warm = await context.newPage();
  await warm.goto(PAGE);
  await warm.waitForFunction(loaded, null, { timeout: DEADLINE_MS, polling: 250 });
  await warm.close();

  const page = await context.newPage();
  await page.addInitScript(INSTRUMENT);
  page.on('pageerror', (error) => step(`pageerror: ${error.message}`));
  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    frames.push({ data, at: metadata.timestamp * 1000 });
    await cdp.send('Page.screencastFrameAck', { sessionId });
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: WIDTH, maxHeight: HEIGHT });
  step('recording');
  await page.goto(PAGE);
  await page.waitForFunction(loaded, null, { timeout: DEADLINE_MS, polling: 250 });
  await pause(1000);
  await page.setInputFiles('#file', IMAGE);
  await page.waitForSelector('canvas[data-image]');
  await clickOn(page, '#message');
  await page.locator('#message').pressSequentially(QUESTION, { delay: 25 });
  await clickOn(page, '#thinking');
  await clickOn(page, '#send');
  step('replying');
  await page.locator('.chat').evaluate((chat) => chat.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await page.waitForFunction(idle, null, { timeout: DEADLINE_MS, polling: 250 });
  await pause(HOLD_MS);
  await cdp.send('Page.stopScreencast');
  const stoppedAt = Date.now();
  const tiles = await Promise.all(['first', 'speed', 'tokens', 'requests', 'runtime', 'status'].map(async (id) => `${id}: ${await page.textContent(`#${id}`)}`));
  console.log(tiles.join('\n'));
  await context.close();

  // The screencast only sends a frame when the page changes: each frame lasts until the next.
  const list = frames.map((frame, index) => {
    const file = join(work, `${String(index).padStart(5, '0')}.png`);
    writeFileSync(file, Buffer.from(frame.data, 'base64'));
    const next = frames[index + 1]?.at ?? stoppedAt;
    return `file '${file}'\nduration ${((next - frame.at) / 1000).toFixed(4)}`;
  });
  writeFileSync(join(work, 'frames.txt'), `${list.join('\n')}\nfile '${join(work, `${String(frames.length - 1).padStart(5, '0')}.png`)}'\n`);
  step('encoding');
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt'),
    '-filter_complex', `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0', OUTPUT,
  ]);
  step(`${OUTPUT}: ${frames.length} frames`);
} finally {
  server.kill();
  rmSync(profile, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
