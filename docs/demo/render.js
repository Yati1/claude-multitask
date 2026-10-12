// node render.js            -- every frame of scene.html into frames/ (with frames/index.json)
// node render.js snap 6800  -- stills of the given moments (ms) into snaps/
//
// Drives a local Chrome or Edge, headless, at the scene's size (its SIZE) and 1x: the
// browser named by CHROME_PATH, else the first found in the usual places.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');

const STEP_MS = 50; // 20 frames a second; frames that do not change are merged when encoding

function browserPath() {
  const env = process.env;
  const pf = env.PROGRAMFILES, pf86 = env['PROGRAMFILES(X86)'], local = env.LOCALAPPDATA;
  const candidates = [
    env.CHROME_PATH,
    env.PUPPETEER_EXECUTABLE_PATH,
    pf && path.join(pf, 'Google/Chrome/Application/chrome.exe'),
    pf86 && path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
    local && path.join(local, 'Google/Chrome/Application/chrome.exe'),
    pf86 && path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    pf && path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  const hit = candidates.find(p => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome or Edge found: set CHROME_PATH to one');
  return hit;
}

(async () => {
  const [mode, ...rest] = process.argv.slice(2);
  // a fresh profile, so a browser already open is left alone
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-chrome-'));
  const browser = await puppeteer.launch({
    executablePath: browserPath(),
    headless: true,
    userDataDir: profile,
    args: ['--no-first-run', '--no-default-browser-check', '--force-color-profile=srgb', '--hide-scrollbars'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(__dirname, 'scene.html')).href);
    await page.waitForFunction('window.ready === true');
    const [W, H] = await page.evaluate('window.SIZE');
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    if (mode === 'snap') {
      const dir = path.join(__dirname, 'snaps');
      fs.mkdirSync(dir, { recursive: true });
      for (const t of rest.map(Number)) {
        await page.evaluate(t => window.render(t), t);
        await page.screenshot({ path: path.join(dir, `t${t}.png`) });
        console.log('snap', path.join(dir, `t${t}.png`));
      }
      return;
    }
    const end = await page.evaluate('window.END');
    const samples = await page.evaluate('window.SAMPLES');
    const dir = path.join(__dirname, 'frames');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const list = [];
    for (let t = 0, i = 0; t < end; t += STEP_MS, i++) {
      await page.evaluate(t => window.render(t), t);
      const f = `f${String(i).padStart(5, '0')}.png`;
      await page.screenshot({ path: path.join(dir, f) });
      list.push({ t, f });
    }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ width: W, height: H, step: STEP_MS, samples, list }));
    console.log('frames', list.length, 'in', dir);
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
