// Génération des favicons et icônes PWA à partir de favicon.png (512×512).
//
// Usage : node scripts/generate-favicons.js
//
// Produit dans assets/ :
//   favicon-16x16.png, favicon-32x32.png, favicon-48x48.png (interne ICO)
//   apple-touch-icon.png (180×180)
//   android-chrome-192x192.png, android-chrome-512x512.png
//   favicon.ico (multi-résolution 16/32/48)

import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const SOURCE = resolve(REPO_ROOT, 'favicon.png');
const OUT_DIR = resolve(REPO_ROOT, 'assets');

const TARGETS = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'android-chrome-192x192.png', size: 192 },
  { name: 'android-chrome-512x512.png', size: 512 },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // Vérifie la source
  const src = await readFile(SOURCE);
  const meta = await sharp(src).metadata();
  console.log(`Source : favicon.png ${meta.width}×${meta.height} (${meta.format})`);
  if (meta.width < 512 || meta.height < 512) {
    console.warn(`Avertissement : source < 512×512, le rendu 512 sera flou.`);
  }

  // Génère chaque taille PNG. Lanczos3 + qualité 100 pour le détail max.
  for (const { name, size } of TARGETS) {
    const out = resolve(OUT_DIR, name);
    await sharp(src)
      .resize(size, size, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, quality: 100 })
      .toFile(out);
    const written = (await readFile(out)).byteLength;
    console.log(`  → ${name} (${size}×${size}, ${(written / 1024).toFixed(1)} KB)`);
  }

  // favicon.ico multi-résolution 16/32/48
  const buf16 = await sharp(src).resize(16, 16, { kernel: 'lanczos3' }).png().toBuffer();
  const buf32 = await sharp(src).resize(32, 32, { kernel: 'lanczos3' }).png().toBuffer();
  const buf48 = await sharp(src).resize(48, 48, { kernel: 'lanczos3' }).png().toBuffer();
  const ico = await pngToIco([buf16, buf32, buf48]);
  const icoOut = resolve(OUT_DIR, 'favicon.ico');
  await writeFile(icoOut, ico);
  console.log(`  → favicon.ico (16+32+48 multi-résolution, ${(ico.byteLength / 1024).toFixed(1)} KB)`);

  console.log('\n✓ Favicons générés dans assets/');
}

main().catch((err) => { console.error('crashed:', err); process.exit(1); });
