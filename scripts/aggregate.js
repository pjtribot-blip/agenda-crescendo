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
import { scrapeFestivalStavelot } from './scrapers/festival-stavelot.js';
import { scrapeFestivalSilly } from './scrapers/festival-silly.js';
import { scrapeMusiq3BW, scrapeNuitsSeptembre } from './scrapers/festivals-de-wallonie.js';
import { scrapeMIM } from './scrapers/mim.js';
import { scrapeMusicorum } from './scrapers/musicorum.js';
import { scrapeMidiMinimes } from './scrapers/midi-minimes.js';
import { scrapeMAFestival } from './scrapers/ma-festival.js';
import { scrapeVoixIntimes } from './scrapers/voix-intimes.js';
import { scrapeCRB } from './scrapers/crb.js';
import { scrapeKBR } from './scrapers/kbr.js';
import { scrapeChapelle } from './scrapers/chapelle-reine-elisabeth.js';
import { scrapeArsenalMetz } from './scrapers/arsenal-metz.js';
import { scrapeStMichel } from './scrapers/festival-st-michel.js';
import { scrapeArtsAuCarre } from './scrapers/arts-au-carre.js';
import { scrapeLillePianos } from './scrapers/lille-pianos.js';
import { scrapeHardelot } from './scrapers/midsummer-hardelot.js';
import { scrapeTriangel } from './scrapers/triangel.js';
import { scrapeOBF } from './scrapers/obf.js';
import { scrapeAMUZ } from './scrapers/amuz.js';
import { scrapeMidiLiege } from './scrapers/midiliege.js';
import { scrapeAntwerpSymphony } from './scrapers/antwerp-symphony.js';
import { scrapeVrijthofMaastricht } from './scrapers/vrijthof-maastricht.js';
import { scrapeFestivalLaon } from './scrapers/festival-laon.js';
import { loadOBVManual } from './scrapers/obv-manual.js';
import { loadONLManual } from './scrapers/onl-manual.js';
import { scrapeWildeWesten } from './scrapers/wildewesten.js';
import { scrapeValDieu } from './scrapers/concerts-printemps-valdieu.js';
import { scrapeSenghor } from './scrapers/senghor.js';

import { cleanComposers, augmentComposers, loadComposerIndex } from './utils/composer-filter.js';

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
  { name: 'stavelot', fn: scrapeFestivalStavelot },
  { name: 'silly', fn: scrapeFestivalSilly },
  { name: 'musiq3-bw', fn: scrapeMusiq3BW },
  { name: 'nuits-septembre', fn: scrapeNuitsSeptembre },
  { name: 'mim', fn: scrapeMIM },
  { name: 'musicorum', fn: scrapeMusicorum },
  { name: 'midi-minimes', fn: scrapeMidiMinimes },
  { name: 'ma-festival', fn: scrapeMAFestival },
  { name: 'voix-intimes', fn: scrapeVoixIntimes },
  { name: 'crb', fn: scrapeCRB },
  { name: 'kbr', fn: scrapeKBR },
  { name: 'chapelle', fn: scrapeChapelle },
  { name: 'arsenal-metz', fn: scrapeArsenalMetz },
  { name: 'st-michel', fn: scrapeStMichel },
  { name: 'arts-au-carre', fn: scrapeArtsAuCarre },
  { name: 'lille-pianos', fn: scrapeLillePianos },
  { name: 'hardelot', fn: scrapeHardelot },
  { name: 'triangel', fn: scrapeTriangel },
  { name: 'obf', fn: scrapeOBF },
  { name: 'amuz', fn: scrapeAMUZ },
  { name: 'midiliege', fn: scrapeMidiLiege },
  { name: 'antwerp-symphony', fn: scrapeAntwerpSymphony },
  { name: 'vrijthof', fn: scrapeVrijthofMaastricht },
  { name: 'festival-laon', fn: scrapeFestivalLaon },
  { name: 'obv', fn: loadOBVManual },
  { name: 'onl', fn: loadONLManual },
  { name: 'wildewesten', fn: scrapeWildeWesten },
  { name: 'valdieu', fn: scrapeValDieu },
  { name: 'senghor', fn: scrapeSenghor },
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

async function loadFestivals() {
  try {
    const raw = await readFile(resolve(REPO_ROOT, 'data', 'festivals.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Pour chaque concert, on attache `festival: "ID"` si sa date tombe
// dans la fenêtre [date_start, date_end] d'un festival ET que son
// venue_id est listé dans festivals.json. Un concert peut être taggé
// par plusieurs festivals (cycle dans cycle) — on émet alors `festivals`
// (tableau) plutôt que `festival` (chaîne unique).
function applyFestivalTags(concerts, festivals) {
  if (!festivals.length) return { taggedCount: 0 };
  let taggedCount = 0;
  for (const c of concerts) {
    if (!c.date || !c.venue_id) continue;
    const matches = [];
    for (const f of festivals) {
      if (!f.venues || !f.venues.includes(c.venue_id)) continue;
      if (f.date_start && c.date < f.date_start) continue;
      if (f.date_end && c.date > f.date_end) continue;
      matches.push(f.id);
    }
    if (matches.length === 1) {
      c.festival = matches[0];
      taggedCount++;
    } else if (matches.length > 1) {
      c.festivals = matches;
      taggedCount++;
    }
  }
  return { taggedCount };
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

  let all = [];
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

  // Filet de sécurité : on dédupe les IDs en collision en suffixant -2,
  // -3, etc. Une collision = bug dans le buildId d'un scraper qui devrait
  // intégrer l'heure (ou un autre discriminant). On log pour qu'on puisse
  // remonter à la source.
  const idCounts = new Map();
  let renamed = 0;
  for (const c of all) {
    const n = (idCounts.get(c.id) || 0) + 1;
    idCounts.set(c.id, n);
    if (n > 1) {
      c.id = `${c.id}-${n}`;
      renamed++;
    }
  }
  if (renamed) console.log(`\n[dedup-id] ${renamed} IDs en collision suffixés (à corriger côté scraper)`);

  // Passe de nettoyage des compositeurs : filtre les ensembles/interprètes
  // qui ont fuité depuis les CMS source, et splitte les listes virgule.
  const composerIndex = await loadComposerIndex();
  let composersCleaned = 0;
  for (const c of all) {
    if (!Array.isArray(c.composers) || !c.composers.length) continue;
    const before = c.composers.slice();
    c.composers = cleanComposers(before, composerIndex);
    if (c.composers.length !== before.length || c.composers.some((x, i) => x !== before[i])) {
      composersCleaned++;
    }
  }
  console.log(`[composer-filter] ${composersCleaned} concerts dont la liste compositeurs a été nettoyée`);

  // Phase 3.24 — augment composers from title + program text via
  // word-boundary matching, avec filtres ensemble (Cuarteto Casals,
  // Schumann Quartett, Tallis Scholars) et hommage (Bruckner Etude,
  // Mozartiana, Hommage à X). Récupère les compositeurs présents
  // dans le texte mais ratés par les scrapers (Mernier dans Bartleby,
  // Jongen dans LAPS Ensemble / Tableaux pittoresques, Peter Benoit
  // dans Lucifer en De Schelde, etc.).
  let composersAugmented = 0;
  const augStats = new Map();
  for (const c of all) {
    const additions = augmentComposers(c, composerIndex);
    if (additions.length) {
      composersAugmented++;
      c.composers = [...new Set([...(c.composers || []), ...additions])];
      for (const a of additions) augStats.set(a, (augStats.get(a) || 0) + 1);
    }
  }
  if (composersAugmented) {
    const top = [...augStats].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, k]) => `${n} ×${k}`).join(', ');
    console.log(`[composer-augment] ${composersAugmented} concerts augmentés (top: ${top})`);
  }

  // Mojibake textuel : certaines sources (midis-minimes.be) ont
  // littéralement "?" à la place de diacritiques slaves dans leur
  // CMS. On remplace les occurrences connues dans title/program.
  // À étendre si d'autres cas apparaissent.
  const MOJIBAKE = [
    [/Jan[aá]\?ek/g, 'Janáček'],
    [/Dvo\?[aá]k/g, 'Dvořák'],
    [/Martin\?/g, 'Martinů'],
    [/G\?recki/g, 'Górecki'],
    [/Lutos\?awski/g, 'Lutosławski'],
  ];
  let textFixed = 0;
  for (const c of all) {
    for (const f of ['title', 'program']) {
      const v = c[f];
      if (!v || !v.includes('?')) continue;
      let fixed = v;
      for (const [re, rep] of MOJIBAKE) fixed = fixed.replace(re, rep);
      if (fixed !== v) { c[f] = fixed; textFixed++; }
    }
  }
  if (textFixed) console.log(`[mojibake] ${textFixed} title/program corrigés`);

  // Dédoublonnage cross-source : un concert OBF au Triangel supersède
  // sa version captée par triangel.js (le scraper OBF a la fiche
  // programme officielle du festival, plus complète). On match par
  // (venue_id='triangel', date, time). On filtre le tableau en
  // supprimant l'entrée triangel.js doublonnée.
  // Règle générique : pour chaque paire (source prioritaire, source
  // dédoublonnée) on supprime de la 2e les concerts dont (venue_id,
  // date, time) matche un concert de la 1re. La 1re est conservée
  // car elle a typiquement plus de contexte (programme, prix).
  const DEDUP_CROSS = [
    { primary: 'obf', secondary: 'triangel', label: 'OBF' },
    { primary: 'antwerp-symphony', secondary: 'amuz', label: 'Antwerp Symphony' },
  ];
  for (const { primary, secondary, label } of DEDUP_CROSS) {
    const keys = new Set();
    for (const c of all) {
      if (c.source === primary && c.venue_id === secondary) {
        keys.add(`${c.date}|${c.time || ''}`);
      }
    }
    const before = all.length;
    all = all.filter((c) => {
      if (c.source !== secondary) return true;
      return !keys.has(`${c.date}|${c.time || ''}`);
    });
    const removed = before - all.length;
    if (removed) console.log(`[dedup-cross] ${removed} concerts ${secondary} supersédés par leur version ${label}`);
  }

  // Tagging des festivals (sur les concerts agrégés, avant écriture)
  const festivals = await loadFestivals();
  const tagSummary = applyFestivalTags(all, festivals);
  if (festivals.length) {
    console.log(`\n[festivals] ${festivals.length} festivals chargés, ${tagSummary.taggedCount} concerts taggés`);
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
