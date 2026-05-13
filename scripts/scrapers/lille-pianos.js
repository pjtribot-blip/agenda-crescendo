// Scraper Lille Piano(s) Festival (23e édition, 12-14 juin 2026)
//
// Festival organisé par l'Orchestre National de Lille — concerts dans
// plusieurs lieux lillois : Auditorium ONL/Nouveau Siècle, Cathédrale
// Notre-Dame de la Treille, Théâtre du Casino Barrière, Gare Saint
// Sauveur (cinéma + bar), Conservatoire de Lille, etc.
//
// Site WordPress avec une page par jour :
//   /2026/jeudi-12-juin_p01/  (préludes éventuels)
//   /2026/vendredi_12_juin/
//   /2026/samedi_13_juin/
//   /2026/dimanche_14_juin/
//   /2026/et_aussi/
//
// Chaque concert est rendu comme une suite de 5 headings consécutifs :
//   1. JOUR JJ • HHhMM > HHhMM   (date + range horaire)
//   2. ARTISTE / PERFORMER       (titre principal du concert)
//   3. Description courte        (Récital, Concert symphonique, Jazz…)
//   4. NOM DU LIEU (ALL CAPS)
//   5. TARIF / GRATUIT
// On repère le pattern (1) puis on prend les 4 headings suivants.
//
// venue_id : "lille-pianos-festival" (umbrella — comme Stavelot,
// Voix Intimes, MA Festival). Le lieu réel est conservé dans
// `program` pour ne pas perdre l'info.
//
// festival_id : "lille-pianos-2026" (tagging auto via festivals.json,
// fenêtre 12-14 juin 2026).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.lillepianosfestival.fr';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Pages jour avec leur date ISO. La page "et_aussi" couvre les
// événements "off" sans date unique — on l'omet par défaut (les
// concerts y sont des conférences/rencontres, hors périmètre).
const DAY_PAGES = [
  { slug: 'jeudi-12-juin_p01', iso: '2026-06-11' }, // préludes
  { slug: 'vendredi_12_juin',  iso: '2026-06-12' },
  { slug: 'samedi_13_juin',    iso: '2026-06-13' },
  { slug: 'dimanche_14_juin',  iso: '2026-06-14' },
];

// Pattern d'en-tête concert : "JOUR JJ • HH[hMM] > HH[hMM]"
const CONCERT_HEADER = /^(?:LUNDI|MARDI|MERCREDI|JEUDI|VENDREDI|SAMEDI|DIMANCHE)\s+\d{1,2}\s*[•·]\s*(\d{1,2})[hH](\d{0,2})\s*[>›]\s*\d{1,2}[hH]\d{0,2}/i;

// ------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------
async function fetchHtml(url, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9',
        },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(800 * (attempt + 1));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014', eacute: 'é', egrave: 'è',
};
function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] !== undefined ? NAMED_ENTITIES[name] : m);
}

// ------------------------------------------------------------------
// Composer detection
// ------------------------------------------------------------------
let _composerIndex = null;
async function loadComposerIndex() {
  if (_composerIndex) return _composerIndex;
  const path = resolve(REPO_ROOT, 'data', 'composers-reference.json');
  const json = JSON.parse(await readFile(path, 'utf8'));
  const entries = [];
  for (const c of json.composers) {
    for (const alias of c.aliases) {
      entries.push({ canonical: c.name, alias, norm: normalize(alias) });
    }
  }
  entries.sort((a, b) => b.norm.length - a.norm.length);
  _composerIndex = entries;
  return entries;
}

// ------------------------------------------------------------------
// Day page parsing
// ------------------------------------------------------------------
function parseDayPage(html, isoDate) {
  const $ = cheerio.load(html);
  // Récupère tous les headings dans l'ordre du DOM.
  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const t = decodeEntities($(el).text().trim()).replace(/\s+/g, ' ');
    if (t) headings.push(t);
  });

  const concerts = [];
  for (let i = 0; i < headings.length; i++) {
    const m = headings[i].match(CONCERT_HEADER);
    if (!m) continue;
    const hh = m[1].padStart(2, '0');
    const mm = (m[2] || '00').padStart(2, '0');
    const time = `${hh}:${mm}`;
    // Les 4 lignes suivantes : artiste, type, lieu, tarif.
    const artist = headings[i + 1] || '';
    const kind = headings[i + 2] || '';
    const place = headings[i + 3] || '';
    const price = headings[i + 4] || '';
    if (!artist) continue;
    concerts.push({
      isoDate, time, artist, kind, place, price,
      header: headings[i],
    });
  }
  return concerts;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, slug, time, artist) {
  const t = time ? `-${time.replace(':', '')}` : '';
  const aSlug = normalize(artist).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `lille-pianos-${date}${t}-${aSlug || slug}`.replace(/--+/g, '-').slice(0, 200);
}

function parsePrice(s) {
  if (!s) return [null, null];
  if (/gratuit/i.test(s)) return [0, 0];
  const m = s.match(/(\d{1,3})\s*(?:€|euros?|à\s*(\d{1,3}))/i);
  if (!m) return [null, null];
  // "TARIF B : DE 12 À 24€"
  const range = s.match(/(\d{1,3})\s*[àÀ]\s*(\d{1,3})/);
  if (range) return [parseInt(range[1], 10), parseInt(range[2], 10)];
  return [parseInt(m[1], 10), parseInt(m[1], 10)];
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeLillePianos({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const concerts = [];
  for (const { slug, iso } of DAY_PAGES) {
    if (iso < today) continue;
    const url = `${BASE_URL}/2026/${slug}/`;
    console.error(`[lille-pianos] ${url}`);
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.error(`[lille-pianos]   échec : ${err.message}`);
      continue;
    }
    const dayConcerts = parseDayPage(html, iso);
    console.error(`[lille-pianos]   ${dayConcerts.length} concerts détectés`);
    for (const c of dayConcerts) {
      const composers = matchComposers(`${c.artist} ${c.kind}`, composerIndex);
      const [pmin, pmax] = parsePrice(c.price);
      const programParts = [c.kind, c.place].filter(Boolean);
      concerts.push({
        id: buildId(c.isoDate, slug, c.time, c.artist),
        source: 'lille-pianos',
        venue_id: 'lille-pianos-festival',
        title: c.artist,
        date: c.isoDate,
        time: c.time,
        url,
        composers,
        performers: [c.artist],
        program: programParts.join(' — ') || null,
        price_min: pmin,
        price_max: pmax,
        scraped_at: new Date().toISOString(),
      });
    }
    await sleep(200);
  }

  // Dédupe (date, time, normalize(title))
  const seen = new Set();
  const out = [];
  for (const c of concerts) {
    const k = `${c.date}|${c.time||''}|${normalize(c.title).slice(0,60)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }

  console.error(`[lille-pianos] ${out.length} concerts produits (dédupe ${concerts.length - out.length})`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeLillePianos()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
