'use strict';

/**
 * Checks what CI can actually check about the committed screenshots.
 *
 *   node tool/check_screenshots.js
 *
 * WHAT THIS CANNOT DO, SAID FIRST
 *
 * It cannot tell you the screenshots still look like the app. Doing that means
 * rebuilding the Flutter web bundle, starting the backend, driving headless
 * Chrome and diffing pixels -- and the diff would fail on every run for reasons
 * unconnected to the UI, because font rasterisation differs between a Windows
 * machine and a Linux runner. A check that fails for irrelevant reasons gets
 * disabled, and then nothing is checked at all.
 *
 * So the honest position is: keeping the images current is a manual step, done by
 * running `node tool/capture_screenshots.js` when the screen changes. This
 * catches the failures that ARE mechanical, which is most of the ways a
 * screenshot set actually rots:
 *
 *   - the capture script produces a name that is not committed, or vice versa,
 *     which is what happens when a capture is added or renamed and the commit
 *     misses it
 *   - the README references an image that does not exist, so a reader sees a
 *     broken image and nothing failed
 *   - an image exists but is empty, truncated, or not a PNG -- the shape a
 *     half-written capture leaves behind
 *   - an image is a single flat colour, which is what a blank canvas looks like
 *     when the renderer failed and the capture "succeeded"
 *
 * That last one is the reason this is worth having. The first attempt at
 * capturing these produced a perfectly valid PNG of the loading indicator, and a
 * renderer failure in CI would produce a perfectly valid PNG of nothing.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'screenshots');
const README = path.join(ROOT, 'README.md');
const CAPTURE = path.join(ROOT, 'tool', 'capture_screenshots.js');

const MIN_BYTES = 8 * 1024;

/** PNG header: 8-byte signature, then an IHDR chunk carrying width and height. */
function readPngHeader(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

/**
 * Is the image a single flat colour?
 *
 * Approximated by compressing the file's pixel data a second time: a screenshot
 * of a real interface still has structure after PNG's own compression, while a
 * blank canvas is already near-optimally compressed and shrinks almost to
 * nothing. Cheap, dependency-free, and it only has to separate "a page" from
 * "one colour", which is a wide gap.
 */
function looksBlank(buffer) {
  const recompressed = zlib.gzipSync(buffer, { level: 9 }).length;
  return recompressed < 2048;
}

function main() {
  const problems = [];

  if (!fs.existsSync(DIR)) {
    console.error(`no screenshot directory at ${path.relative(ROOT, DIR)}`);
    process.exit(1);
  }

  const committed = fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();

  // The names the capture script says it produces, read from the script itself so
  // the two cannot drift.
  const captureSource = fs.readFileSync(CAPTURE, 'utf8');
  const expected = [...captureSource.matchAll(/shootWhenStable\(cdp, '([^']+)'/g)]
    .map((m) => `${m[1]}.png`).sort();

  for (const name of expected) {
    if (!committed.includes(name)) {
      problems.push(`the capture script produces ${name}, which is not committed`);
    }
  }
  for (const name of committed) {
    if (!expected.includes(name)) {
      problems.push(`${name} is committed but the capture script no longer produces it`);
    }
  }

  const readme = fs.readFileSync(README, 'utf8');
  for (const m of readme.matchAll(/docs\/screenshots\/([A-Za-z0-9._-]+\.png)/g)) {
    if (!committed.includes(m[1])) {
      problems.push(`README references docs/screenshots/${m[1]}, which does not exist`);
    }
  }

  console.log('');
  console.log(`screenshots in ${path.relative(ROOT, DIR)}`);
  for (const name of committed) {
    const buffer = fs.readFileSync(path.join(DIR, name));
    const header = readPngHeader(buffer);
    const kb = Math.round(buffer.length / 1024);

    if (!header) {
      problems.push(`${name} is not a valid PNG`);
      console.log(`  ${name.padEnd(30)} INVALID`);
      continue;
    }
    if (buffer.length < MIN_BYTES) {
      problems.push(`${name} is ${kb} KB, below the ${MIN_BYTES / 1024} KB floor `
        + '-- a truncated or empty capture');
    }
    if (looksBlank(buffer)) {
      problems.push(`${name} compresses to almost nothing -- it is probably a blank `
        + 'canvas from a failed render, not a screenshot of the app');
    }
    const referenced = readme.includes(`docs/screenshots/${name}`);
    console.log(
      `  ${name.padEnd(30)} ${String(header.width).padStart(4)}x`
      + `${String(header.height).padEnd(5)} ${String(kb).padStart(4)} KB  `
      + `${referenced ? 'in README' : 'not referenced'}`,
    );
  }

  console.log('');
  if (problems.length) {
    console.error('screenshot check failed:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    console.error('  Regenerate with: node tool/capture_screenshots.js');
    console.error('');
    process.exit(1);
  }
  console.log(`  ${committed.length} screenshot(s) present, all valid.`);
  console.log('  Note: this does not check they still match the app. That is a');
  console.log('  manual step -- rerun the capture script when the screen changes.');
  console.log('');
}

main();
