// node encode.js [out.gif]  -- frames/ (from render.js) -> ../demo.gif
//
// One palette of 128 colours for every frame (per-frame palettes flicker), written once
// as the GIF's global table: the most common exact colours of the scene's sample moments
// are kept as they are, so the app's flat greys stay distinct, and the quantizer fills
// the rest. Each frame after the first holds only the rectangle that changed from the
// frame before, and in it a pixel that did not change is transparent, unless it carries
// on a run of its own colour: drawn as it is, it compresses better than a break in the
// run would. A frame identical to the one before only lengthens its delay, so holds cost
// nothing.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { GIFEncoder, quantize } = require('gifenc');

const DEPTH = 7;                  // bits a pixel: 128 colours
const COLORS = 1 << DEPTH;
const TRANSPARENT = COLORS - 1;   // palette index kept for "unchanged"
const FIXED = 32;                 // exact colours kept as they are

const key = (d, i) => (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];

(async () => {
  const out = process.argv[2] ?? path.join(__dirname, '..', 'demo.gif');
  const dir = path.join(__dirname, 'frames');
  const { width: W, height: H, step, samples: sampleTimes, list } = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
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
  const full = [...palette]; while (full.length < COLORS) full.push([0, 0, 0]);
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

  // Writes the frame waiting: the first whole, with the palette, which gifenc makes the
  // global table; any other as its changed rectangle, with no table of its own. gifenc
  // puts every frame at (0, 0), so a rectangle's place is patched in after: a frame
  // starts with its 8-byte graphic control extension, then its image descriptor, 0x2c
  // and its left and top, little-endian.
  const gif = GIFEncoder();
  let prev = null, pending = null, frames = 0;
  const flush = () => {
    if (!pending) return;
    const opts = { delay: pending.delay, dispose: 1, repeat: 0, colorDepth: DEPTH };
    if (!pending.box) gif.writeFrame(pending.data, W, H, { ...opts, palette: full });
    else {
      const { x, y, w, h } = pending.box;
      const at = gif.bytesView().length;
      gif.writeFrame(pending.data, w, h, { ...opts, transparent: true, transparentIndex: TRANSPARENT });
      const v = gif.bytesView();
      if (v[at + 8] !== 0x2c) throw new Error('image descriptor not where expected: has gifenc changed?');
      v[at + 9] = x & 255; v[at + 10] = x >> 8; v[at + 11] = y & 255; v[at + 12] = y >> 8;
    }
    frames++;
  };
  for (const { f } of list) {
    const idx = indexed(await rgbaOf(f));
    if (prev) {
      // the rectangle that changed
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let i = 0; i < idx.length; i++) if (idx[i] !== prev[i]) {
        const x = i % W, y = (i / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 < 0) { pending.delay += step; continue; }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const data = new Uint8Array(w * h);
      for (let y = 0, j = 0; y < h; y++) for (let x = 0; x < w; x++, j++) {
        const i = (y0 + y) * W + x0 + x;
        data[j] = idx[i] !== prev[i] || (j > 0 && data[j - 1] === idx[i]) ? idx[i] : TRANSPARENT;
      }
      flush();
      pending = { data, delay: step, box: { x: x0, y: y0, w, h } };
    } else pending = { data: idx, delay: step };
    prev = idx;
  }
  flush();
  gif.finish();
  fs.writeFileSync(out, gif.bytes());
  console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB,', frames, 'frames from', list.length);
})();
