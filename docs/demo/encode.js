// node encode.js [out.gif]  -- frames/ (from render.js) -> ../demo.gif
//
// One palette for every frame (per-frame palettes flicker): the most common exact
// colours of the scene's sample moments are kept as they are, so the app's flat greys
// stay distinct, and the quantizer fills the rest. A pixel unchanged from the frame
// before is drawn transparent, and a frame identical to the one before only lengthens
// its delay, so holds cost nothing.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { GIFEncoder, quantize } = require('gifenc');

const W = 880, H = 560;
const TRANSPARENT = 255;          // palette index kept for "unchanged"
const FIXED = 64;                 // exact colours kept as they are

const key = (d, i) => (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];

(async () => {
  const out = process.argv[2] ?? path.join(__dirname, '..', 'demo.gif');
  const dir = path.join(__dirname, 'frames');
  const { step, samples: sampleTimes, list } = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const rgbaOf = async f => new Uint8Array(await sharp(path.join(dir, f)).ensureAlpha().raw().toBuffer());

  // the palette
  const samples = [];
  for (const t of sampleTimes) samples.push(await rgbaOf(list[Math.min(list.length - 1, Math.round(t / step))].f));
  const counts = new Map();
  for (const s of samples) for (let i = 0; i < s.length; i += 4) { const k = key(s, i); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const fixed = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, FIXED).map(([k]) => k);
  const fixedSet = new Set(fixed);
  const restPx = [];
  for (const s of samples) for (let i = 0; i < s.length; i += 4) if (!fixedSet.has(key(s, i))) restPx.push(s[i], s[i + 1], s[i + 2], 255);
  const rest = restPx.length ? quantize(new Uint8Array(restPx), TRANSPARENT - FIXED, { format: 'rgb565' }) : [];
  const palette = [...fixed.map(k => [k >> 16, (k >> 8) & 255, k & 255]), ...rest].slice(0, TRANSPARENT);
  const full = [...palette]; while (full.length < 256) full.push([0, 0, 0]);
  console.log('palette', palette.length, 'colours (', fixed.length, 'exact )');

  // nearest palette entry for each exact colour, remembered
  const cache = new Map();
  const nearest = k => {
    let i = cache.get(k);
    if (i !== undefined) return i;
    const r = k >> 16, g = (k >> 8) & 255, b = k & 255;
    let best = 0, bd = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const [pr, pg, pb] = palette[p];
      const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
      if (d < bd) { bd = d; best = p; if (d === 0) break; }
    }
    cache.set(k, best);
    return best;
  };
  const indexed = rgba => { const o = new Uint8Array(W * H); for (let i = 0, j = 0; j < o.length; i += 4, j++) o[j] = nearest(key(rgba, i)); return o; };

  const gif = GIFEncoder();
  let prev = null, pending = null, frames = 0;
  const flush = () => {
    if (!pending) return;
    gif.writeFrame(pending.data, W, H, { palette: full, delay: pending.delay, transparent: !pending.first, transparentIndex: TRANSPARENT, dispose: 1, repeat: 0, first: pending.first });
    frames++;
  };
  for (const { f } of list) {
    const idx = indexed(await rgbaOf(f));
    if (prev) {
      let changed = false;
      const data = new Uint8Array(idx.length);
      for (let i = 0; i < idx.length; i++) if (idx[i] === prev[i]) data[i] = TRANSPARENT; else { data[i] = idx[i]; changed = true; }
      if (!changed) { pending.delay += step; continue; }
      flush();
      pending = { data, delay: step, first: false };
    } else pending = { data: idx, delay: step, first: true };
    prev = idx;
  }
  flush();
  gif.finish();
  fs.writeFileSync(out, gif.bytes());
  console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB,', frames, 'frames from', list.length);
})();
