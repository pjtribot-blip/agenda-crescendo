// Agrégateur — exécute tous les scrapers et écrit data/concerts.json
//
// Chaque scraper expose une fonction async qui retourne un tableau de concerts
// au format documenté dans README.md. Si un scraper échoue, on log l'erreur et
// on continue avec les autres : on ne veut jamais qu'une seule source en panne
// vide tout le fichier.

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { scrapeBozar } from './scrapers/bozar.js';
import { scrapeMonnaie } from './scrapers/monnaie.js';
import { scrapeFlagey } from './scrapers/flagey.js';
import { scrapeConcertgebouwBrugge } from './scrapers/concertgebouwbrugge.js';
import { scrapeOPRL } from './scrapers/oprl.js';
import { scrapeORW } from './scrapers/orw.js';
import { scrapeGrandManege } from './scrapers/grand-manege.js';
import { scrapeMARS } from './scrapers/mars.js';
import { scrapePBA } from './scrapers/pba.js';
import { scrapeDeSingel } from './scrapers/desingel.js';
import { scrapeDeBijloke } from './scrapers/debijloke.js';
import { scrapePhilLuxembourg } from './scrapers/philharmonie-luxembourg.js';
import { scrapeOperaLille } from './scrapers/opera-lille.js';
import { scrapeTourcoing } from './scrapers/tourcoing.js';
import { scrapeTournai } from './scrapers/tournai.js';
import { scrapeFermeDuBiereau } from './scrapers/ferme-du-biereau.js';
import { scrapeCCHA } from './scrapers/ccha-hasselt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT = resolve(REPO_ROOT, 'data', 'concerts.json');

const SCRAPERS = [
  { name: 'bozar', fn: scrapeBozar },
  { name: 'monnaie', fn: scrapeMonnaie },
  { name: 'flagey', fn: scrapeFlagey },
  { name: 'cgbrugge', fn: scrapeConcertgebouwBrugge },
  { name: 'oprl', fn: scrapeOPRL },
  { name: 'orw', fn: scrapeORW },
  { name: 'gmanege', fn: scrapeGrandManege },
  { name: 'mars', fn: scrapeMARS },
  { name: 'pba', fn: scrapePBA },
  { name: 'desingel', fn: scrapeDeSingel },
  { name: 'bijloke', fn: scrapeDeBijloke },
  { name: 'phillux', fn: scrapePhilLuxembourg },
  { name: 'opl', fn: scrapeOperaLille },
  { name: 'tourcoing', fn: scrapeTourcoing },
  { name: 'tournai', fn: scrapeTournai },
  { name: 'biereau', fn: scrapeFermeDuBiereau },
  { name: 'ccha', fn: scrapeCCHA },
  // Phase 2.x : ajouter ici les scrapers suivants.
];

async function loadExisting() {
  try {
    const raw = await readFile(OUTPUT, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.concerts)) return parsed.concerts;
  } catch {}
  return [];
}

async function main() {
  const t0 = Date.now();
  console.log('=== Agenda Crescendo — agrégation des sources ===\n');

  const existing = await loadExisting();
  const existingBySource = new Map();
  for (const c of existing) {
    if (!existingBySource.has(c.source)) existingBySource.set(c.source, []);
    existingBySource.get(c.source).push(c);
  }

  const all = [];
  const summary = [];

  for (const { name, fn } of SCRAPERS) {
    const t = Date.now();
    process.stdout.write(`▸ ${name}…\n`);
    try {
      const results = await fn();
      const ms = Date.now() - t;
      console.log(`  ✓ ${results.length} concerts (${ms} ms)`);
      summary.push({ name, count: results.length, ok: true, ms });
      all.push(...results);
    } catch (err) {
      const ms = Date.now() - t;
      console.error(`  ✗ ${name} failed: ${err.message}`);
      summary.push({ name, count: 0, ok: false, error: err.message, ms });
      // On garde la dernière liste connue de cette source pour ne pas
      // perdre les concerts déjà publiés à cause d'un site momentanément KO.
      const fallback = existingBySource.get(name) || [];
      if (fallback.length) {
        console.error(`  ↳ fallback to last known ${fallback.length} concerts from previous run`);
        all.push(...fallback);
      }
    }
  }

  // Tri chronologique
  all.sort((a, b) => {
    const d = (a.date || '').localeCompare(b.date || '');
    if (d !== 0) return d;
    return (a.time || '').localeCompare(b.time || '');
  });

  await writeFile(OUTPUT, JSON.stringify(all, null, 2) + '\n', 'utf8');

  const ms = Date.now() - t0;
  console.log(`\n=== ${all.length} concerts → ${OUTPUT} (${ms} ms total) ===`);
  for (const s of summary) {
    const status = s.ok ? '✓' : '✗';
    const label = s.ok ? `${s.count} concerts` : `failed: ${s.error}`;
    console.log(`  ${status} ${s.name.padEnd(12)} ${label}`);
  }
}

main().catch((err) => {
  console.error('\nAggregator crashed:', err);
  process.exit(1);
});
