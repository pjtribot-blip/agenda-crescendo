// Scraper AMUZ (centre de musique ancienne, Anvers)
//
// AMUZ — Augustinus Muziekcentrum, dans l'Église Saint-Augustin
// restaurée d'Anvers. Programmation riche : musique ancienne, baroque,
// polyphonie, musique de chambre, musique vocale. Siège du Festival
// van Vlaanderen Antwerpen et du Laus Polyphoniae (été).
//
// Site WordPress avec WPML. Pas de FR officielle (redirect /fr/ → 404).
// Le /en/ existe en page liste mais les fiches détail individuelles
// redirigent toujours vers NL. On scrape donc via l'API WP custom
// "activity" et les détails en NL.
//
// API : /wp-json/wp/v2/activity?per_page=100 → 89 activités.
// Le champ `acf` est masqué (date événement non exposée par l'API
// publique). On récupère la date+heure depuis la page détail :
//   <div class="data">
//     <h3>Jour DD mois YYYY</h3>           (Don 10 december 2026)
//     <h4><strong>HH:MM - AMUZ</strong></h4>
//   </div>
//
// Filtre par activity_type (terme WP) :
//   Keep IDs : 19 Concert, 44 Kamermuziek, 45 Polyfonie, 42 Vocaal,
//              75 Instrumentaal, 43 Klavier, 81 Orkest, 78 Orkestmuziek,
//              46 Zondag, 74 Muziektheater, 47 Extern programma
//   Reject  : 21 Cursus, 26 Familie, 79 Film, 83 Kunst, 72 Lezing,
//              76 Rondleiding, 88 Performance
//
// Festival Laus Polyphoniae : si concert AMUZ tombe dans la fenêtre
// fin août — début septembre 2026, le tagging festival sera appliqué
// automatiquement via festivals.json (laus-polyphoniae-2026).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://amuz.be';
const API_PATH = '/wp-json/wp/v2/activity?per_page=100&orderby=date&order=desc';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const KEEP_TYPE_IDS = new Set([
  19,  // Concert
  44,  // Kamermuziek
  45,  // Polyfonie
  42,  // Vocaal
  75,  // Instrumentaal
  43,  // Klavier
  81,  // Orkest
  78,  // Orkestmuziek
  46,  // Zondag (concerts du dimanche)
  74,  // Muziektheater
  47,  // Extern programma (à doser via TITLE_REJECT_PATTERNS)
]);

// Beaucoup de concerts AMUZ taggés UNIQUEMENT "Extern programma" (47)
// sont en réalité d'excellents concerts classiques co-organisés
// (Antwerp Symphony Orchestra, Middagconcerten van Antwerpen, etc.).
// On garde donc le type 47 mais on rejette par titre les organisateurs
// extérieurs clairement non-classiques.
const TITLE_REJECT_PATTERNS = [
  /\bdotan\b/i,
  /\bfkp scorpio\b/i,
  /\blucky star\b/i,
  /\bboekhandel\b/i,            // soirée littéraire
  /\bmarnixring\b/i,             // cercle privé
  /\bflamenco\b/i,
  /familievoorstelling/i,        // famille jeune public
  /\bcursus\b|davidscursus/i,    // cours
];

const MONTHS_NL = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6,
  juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
  jan: 1, feb: 2, mrt: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, okt: 10, nov: 11, dec: 12,
};

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
          'Accept-Language': 'nl-BE,nl;q=0.9,fr;q=0.7,en;q=0.5',
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

async function fetchJson(url, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
        },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(800 * (attempt + 1));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014', eacute: 'é', egrave: 'è',
  ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô',
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

function matchComposers(text, index) {
  const found = new Set();
  if (!text) return [];
  const norm = normalize(text);
  for (const { canonical, norm: alias } of index) {
    if (norm.includes(alias)) found.add(canonical);
  }
  return Array.from(found);
}

// ------------------------------------------------------------------
// Detail parsing — extract date+time from .data block
// ------------------------------------------------------------------
function parseDetail(html) {
  const $ = cheerio.load(html);
  // Le bloc <div class="data"> contient un <h3>WEEKDAY DD mois YYYY</h3>
  // suivi d'un <h4><strong>HH:MM - VENUE_LABEL</strong></h4>.
  let date = null, time = null, description = '';
  $('.data').first().find('h3, h4').each((_, el) => {
    const t = decodeEntities($(el).text().trim()).replace(/\s+/g, ' ');
    if (!date) {
      const m = t.match(/(\d{1,2})\s+([a-zéûô]+)\s+(\d{4})/i);
      if (m) {
        const month = MONTHS_NL[normalize(m[2]).replace(/\.$/, '')];
        if (month) date = `${m[3]}-${String(month).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
      }
    }
    if (!time) {
      const m = t.match(/(\d{1,2}):(\d{2})/);
      if (m) {
        const h = parseInt(m[1], 10);
        if (h >= 0 && h <= 23) time = `${m[1].padStart(2,'0')}:${m[2]}`;
      }
    }
  });
  // Description : article.content ou .entry-content
  description = $('article').first().text().replace(/\s+/g, ' ').trim().slice(0, 1000);
  return { date, time, description };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, slug, time) {
  const t = time ? `-${time.replace(':', '')}` : '';
  return `amuz-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeAMUZ({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  console.error(`[amuz] API ${BASE_URL}${API_PATH}`);
  const activities = await fetchJson(`${BASE_URL}${API_PATH}`);
  console.error(`[amuz] ${activities.length} activités API`);

  let filteredType = 0, past = 0, parsed = 0, noDate = 0, rejectedTitle = 0;
  const concerts = [];
  for (const a of activities) {
    const types = a.activity_type || [];
    if (!types.some((t) => KEEP_TYPE_IDS.has(t))) { filteredType++; continue; }

    const title = decodeEntities(a.title && a.title.rendered || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const url = a.link || '';
    if (!title || !url) continue;
    if (TITLE_REJECT_PATTERNS.some((re) => re.test(title))) { rejectedTitle++; continue; }

    let html;
    try { html = await fetchHtml(url); }
    catch (err) {
      console.error(`[amuz]   détail ${url} échec : ${err.message}`);
      continue;
    }
    const d = parseDetail(html);
    if (!d.date) { noDate++; continue; }
    if (d.date < today) { past++; continue; }

    const composers = matchComposers(`${title} ${d.description.slice(0, 1500)}`, composerIndex);
    concerts.push({
      id: buildId(d.date, a.slug || `id${a.id}`, d.time),
      source: 'amuz',
      venue_id: 'amuz',
      title,
      date: d.date,
      time: d.time,
      url,
      composers,
      performers: [],
      program: d.description.slice(0, 200) || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
    parsed++;
    await sleep(180);
  }

  console.error(`[amuz] retenus ${parsed} | filtre type ${filteredType} | reject titre ${rejectedTitle} | passés ${past} | sans date ${noDate}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeAMUZ()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
