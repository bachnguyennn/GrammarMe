// Draws the GrammarMe icon (white "G" on a deep-green rounded square) and encodes it as PNG
// using only node:zlib — no image dependencies, nothing binary committed to the repo.
import { deflateSync } from 'node:zlib';

const BRAND = [0x5c, 0x6b, 0x54]; // #5c6b54, the site palette's accent
const SAMPLES = 4; // 4×4 supersampling for anti-aliasing

/** Coverage of the icon at normalised point (x, y) in [0,1]²: 0 = transparent, 1 = bg, 2 = glyph. */
function shapeAt(x, y) {
  // Rounded square background.
  const r = 0.22;
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  if (dx * dx + dy * dy > r * r) return 0;
  // "G": a ring open at the upper right, plus a crossbar into the centre.
  const cx = x - 0.5;
  const cy = 0.5 - y; // y up
  const d = Math.hypot(cx, cy);
  const outer = 0.31;
  const inner = 0.195;
  const angle = (Math.atan2(cy, cx) * 180) / Math.PI; // -180..180, 0 = 3 o'clock
  const inRing = d <= outer && d >= inner && !(angle > 0 && angle < 48);
  const inBar = x >= 0.5 && x <= 0.5 + outer && y >= 0.5 && y <= 0.5 + (outer - inner);
  return inRing || inBar ? 2 : 1;
}

export function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let glyph = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const v = shapeAt((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          if (v >= 1) bg++;
          if (v === 2) glyph++;
        }
      }
      const n = SAMPLES * SAMPLES;
      const alpha = bg / n;
      const g = bg ? glyph / bg : 0; // white share of the opaque part
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(BRAND[0] + (255 - BRAND[0]) * g);
      rgba[i + 1] = Math.round(BRAND[1] + (255 - BRAND[1]) * g);
      rgba[i + 2] = Math.round(BRAND[2] + (255 - BRAND[2]) * g);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
