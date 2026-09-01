'use strict';

/**
 * Captures the UI screenshots in docs/screenshots/ from the real running app.
 *
 *   node tool/capture_screenshots.js
 *
 * Prerequisites, and it checks all three rather than producing a blank page:
 *
 *   1. the backend running on :3000, ideally RETRIEVAL_MODE=reranked
 *   2. `flutter build web` output present in build/web
 *   3. Chrome installed
 *
 * WHY A SCRIPT RATHER THAN A FEW MANUAL SCREENSHOTS
 *
 * Screenshots in a README rot faster than any other kind of documentation,
 * because nothing fails when they go stale. A theme change, a renamed label, a
 * reworded failure message -- all of them leave the image looking plausible and
 * wrong, and no test catches it. Regenerating them is then a chore nobody does,
 * so the images quietly become a picture of a version that no longer exists.
 *
 * This makes regeneration one command. The captures are also driven through the
 * real app against the real backend, so an image can only show a state the
 * service actually produced: the leave-balance table is the numbers the API
 * returned, and the cited sources are the policies retrieval actually chose.
 *
 * HOW THE STATES ARE REACHED, AND WHY NO CLICKING
 *
 * Light and dark come from Emulation.setEmulatedMedia rather than from clicking
 * the in-app toggle, because the app follows ThemeMode.system by default -- so
 * emulating the OS preference exercises the same code path a real user's system
 * setting would, and it cannot mis-click.
 *
 * Messages are sent by focusing the composer and inserting text ending in a
 * newline. That is not a trick to avoid the send button: Enter-to-send is
 * implemented in the field's onChanged handler precisely because on web the
 * newline arrives as a text-editing delta from the browser's own textarea rather
 * than as a key event, so this is the path a real keypress takes.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'build', 'web');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const SERVE_PORT = 8422;
const CDP_PORT = 9333;
const API = 'http://localhost:3000';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.bin': 'application/octet-stream',
  '.mjs': 'text/javascript', '.symbols': 'application/octet-stream',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serveWeb() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(WEB_DIR, url === '/' ? 'index.html' : url);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(WEB_DIR, 'index.html');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // CanvasKit/skwasm want these for the multi-threaded paths, and without
      // them the renderer silently falls back and the fonts land differently.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(SERVE_PORT, () => resolve(server)));
}

/** Minimal CDP client. Node 24 has WebSocket built in, so no dependency. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page threw: ${r.exceptionDetails.text}`);
    }
    return r.result.value;
  }
}

async function connect() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
        .then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        return new Cdp(ws);
      }
    } catch {
      // Chrome is still starting; the endpoint refuses connections until it is up.
    }
    await sleep(400);
  }
  throw new Error('could not reach Chrome DevTools endpoint');
}

/**
 * Wait until Flutter has painted something, rather than sleeping a guessed
 * amount. `flt-glass-pane` is the element Flutter web mounts its scene into, and
 * it does not exist until the engine has initialised.
 */
async function waitForFlutter(cdp) {
  for (let i = 0; i < 60; i += 1) {
    const ready = await cdp.eval(
      "!!document.querySelector('flt-glass-pane, flutter-view, flt-scene-host')",
    );
    if (ready) { await sleep(1200); return; }
    await sleep(500);
  }
  throw new Error('Flutter never mounted a view -- check the console for a renderer error');
}

/**
 * Click the composer, then insert the message and a trailing newline.
 *
 * The click lands on the composer by geometry rather than by selector, because
 * the app draws itself into a canvas and there is no DOM element to target. The
 * composer is pinned to the bottom of the viewport, so a point a fixed distance
 * above the bottom edge and left of centre is inside the text field at every
 * width this script uses.
 */
async function sendMessage(cdp, text, { width, height }) {
  const x = Math.round(width * 0.35);
  const y = height - 56;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount: 1,
    });
  }
  await sleep(700);
  await cdp.send('Input.insertText', { text });
  await sleep(400);
  // Enter-to-send: the field's onChanged sees a value ending in a newline.
  await cdp.send('Input.insertText', { text: '\n' });
}

async function frame(cdp) {
  await cdp.eval(
    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))',
  );
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
  });
  return data;
}

/**
 * Capture once the page has stopped changing, rather than after a guessed delay.
 *
 * The first version of this slept 3.5 s per state and produced a screenshot of
 * the "Working" indicator instead of the answer -- in reranked mode the first
 * request also loads a cross-encoder, so a fixed wait is either wrong or wasteful
 * and there is no delay that is reliably both.
 *
 * The thinking indicator is what makes this work: it animates continuously, so
 * while a request is outstanding no two frames are ever identical. Two identical
 * frames therefore mean the indicator is gone and the bubble has finished its
 * entrance. Timing out is reported rather than swallowed, because a screenshot
 * taken mid-request looks fine and documents nothing.
 */
async function shootWhenStable(cdp, name, caption, { timeoutMs = 30000 } = {}) {
  const started = Date.now();
  let previous = null;
  let stable = null;
  while (Date.now() - started < timeoutMs) {
    const current = await frame(cdp);
    if (previous !== null && current === previous) { stable = current; break; }
    previous = current;
    await sleep(700);
  }
  if (!stable) {
    console.log(`  ${`${name}.png`.padEnd(30)}  !!  never settled in `
      + `${timeoutMs / 1000}s -- capturing anyway, CHECK THIS IMAGE`);
    stable = previous;
  }
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(stable, 'base64'));
  const kb = Math.round(fs.statSync(file).size / 1024);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  ${`${name}.png`.padEnd(30)} ${String(kb).padStart(4)} KB  `
    + `${secs.padStart(5)}s   ${caption}`);
}

async function setViewport(cdp, { width, height, mobile = false, scheme = 'light' }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
}

async function main() {
  if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
    throw new Error(`no web build at ${WEB_DIR} -- run \`flutter build web --release `
      + '--dart-define=HR_API_BASE_URL=http://localhost:3000\'');
  }
  const health = await fetch(`${API}/health`).then((r) => r.json()).catch(() => null);
  if (!health) throw new Error(`backend not reachable at ${API} -- run \`npm start\``);
  console.log('');
  console.log(`backend: ${health.retrieval.mode} mode, ${health.knowledgeBase.entries} policies`);

  // Warm the models before Chrome starts. In reranked mode the first request
  // loads a bi-encoder and a cross-encoder from disk, and paying that on the
  // first captured state is how the first attempt at this ended up with a
  // screenshot of the loading indicator.
  process.stdout.write('warming the retrieval models ... ');
  await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'What is the remote work policy?', employee_id: '1001' }),
  }).catch(() => null);
  console.log('done');

  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('no Chrome or Edge binary found');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await serveWeb();
  const profile = path.join(
    process.env.TEMP || '/tmp', `adaas-shots-${process.pid}`,
  );

  const proc = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    // CanvasKit needs WebGL, and a headless container has no GPU. SwiftShader is
    // the software path; without this the canvas comes out blank.
    '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=2',
    'about:blank',
  ], { stdio: 'ignore' });

  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const DESKTOP = { width: 1180, height: 820 };
  const MOBILE = { width: 390, height: 844, mobile: true };

  const load = async (view) => {
    await setViewport(cdp, view);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${SERVE_PORT}/` });
    await waitForFlutter(cdp);
  };

  console.log('');
  console.log(`capturing into ${path.relative(ROOT, OUT_DIR)}`);
  console.log('');

  // 1. The empty state, light. What a first-time user sees.
  await load({ ...DESKTOP, scheme: 'light' });
  await shootWhenStable(cdp, '01-empty-light', 'first run, light theme');

  // 2. A policy question answered from retrieval, with its cited source.
  await sendMessage(cdp, 'Can I work from my house a few days a week?', DESKTOP);
  await shootWhenStable(cdp, '02-policy-answer-light', 'policy answer with cited source');

  // 3. The leave balance table, on real numbers from the API.
  await sendMessage(cdp, 'show my leave balance', DESKTOP);
  await shootWhenStable(cdp, '03-leave-balance-light', 'balance table, live API values');

  // 4. A filed application, and the abstention case, both in dark.
  await load({ ...DESKTOP, scheme: 'dark' });
  await sleep(600);
  await sendMessage(cdp, 'apply for 1 day casual leave', DESKTOP);
  await shootWhenStable(cdp, '04-apply-leave-dark', 'leave filed, dark theme');

  await sendMessage(cdp, 'how do I deploy a Kubernetes ingress controller', DESKTOP);
  await shootWhenStable(cdp, '05-abstention-dark', 'out-of-scope question refused');

  // 5. Mobile width. The composer and the table are the parts that break first.
  await load({ ...MOBILE, scheme: 'light' });
  await sleep(600);
  await sendMessage(cdp, 'show my leave balance', MOBILE);
  await shootWhenStable(cdp, '06-mobile-light', 'mobile width, 390x844');

  await load({ ...MOBILE, scheme: 'dark' });
  await sleep(600);
  await sendMessage(cdp, 'Is a plastic surgery procedure covered?', MOBILE);
  await shootWhenStable(cdp, '07-mobile-dark', 'mobile width, dark theme');

  console.log('');
  proc.kill();
  server.close();
  // Chrome releases its profile lock a moment after the process dies, and
  // deleting it too early throws EPERM on Windows. Best effort: a stale temp
  // profile is harmless, and failing the whole run over cleanup would be worse.
  await sleep(1500);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    console.log(`  (left temp profile at ${profile})`);
  }
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  try { execSync(`taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq *"`, { stdio: 'ignore' }); } catch {}
  process.exit(1);
});
