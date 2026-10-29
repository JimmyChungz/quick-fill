// Resize a source image into the 4 icon sizes Chrome needs (16/32/48/128).
// Supply the source image explicitly using QF_ICON_SRC.
// Override with QF_ICON_SRC=<path>.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'icons');
mkdirSync(OUT_DIR, { recursive: true });

const SRC = process.env.QF_ICON_SRC;
if (!SRC) throw new Error('Set QF_ICON_SRC to the source image path');

const SIZES = [16, 32, 48, 128];

const meta = await sharp(SRC).metadata();
console.log(`source: ${SRC}  (${meta.width}x${meta.height}, ${meta.format})`);

for (const sz of SIZES) {
  const buf = await sharp(SRC)
    .resize(sz, sz, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const out = join(OUT_DIR, `icon-${sz}.png`);
  writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes)`);
}
