// Scraper Espace Senghor (Etterbeek, Bruxelles)
//
// Centre culturel pluridisciplinaire WordPress avec REST API. La
// programmation couvre cinéma, théâtre, danse, jazz métissé, musiques
// du monde, jeune public, ET un volet classique/contemporain/acoustique
// — c'est ce volet qu'on capte ici.
//
// API : /wp-json/wp/v2/project?field=104,130,132,318,483 où les IDs
// sont les termes de la taxonomy `field` :
//   104 Musique contemporaine
//   130 Musique acousmatique
//   132 Musique de création
//   318 Musique classique
//   483 Musique (générique — borderline, gardé par défaut)
// Skip explicitement : 124 musiques-du-monde, 129 jazz-metisse,
// 273 cinéma, 17 théâtre, 15 danse, 206 conférence, 409 jeune-public.
//
// La date d'événement n'est pas exposée par l'API publique (champ acf
// vide). On la récupère depuis la fiche détail /project/{slug}/ qui
// contient un bloc `.sl-date` avec format "DAYABBR DD MOIS" + heure
// "HH:MM" en bloc adjacent. Année déduite de la saison (taxonomy
// `season`) : pour saison "2025-2026", mois 9-12 → 2025, mois 1-8 → 2026.
//
// Filtre éditorial : strict — pas de jazz métissé, pas de musiques du
// monde, pas de chanson, pas de théâtre/danse/jeune public.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.senghor.be';
const API_FIELDS = '104,130,132,318,483';  // contemporaine/acousmatique/creation/classique/musique
const PER_PAGE = 50;

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  janv: 1, fev: 2, févr: 2, avr: 4, juill: 7, aou: 8, sept: 9,
  oct: 10, nov: 11, dec: 12, déc: 12,
};

// ------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------
async function fetchHtml(url, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'fr-BE,fr;q=0.9' },
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
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
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
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
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
// Season metadata (cached)
// ------------------------------------------------------------------
let _seasonsById = null;
async function loadSeasons() {
  if (_seasonsById) return _seasonsById;
  const j = await fetchJson(`${BASE_URL}/wp-json/wp/v2/season?per_page=20`);
  const map = new Map();
  for (const s of j) {
    // slug like "2025-2026" or "24-25"
    const m = (s.slug || '').match(/(\d{2,4})-(\d{2,4})/);
    let startYear = null;
    if (m) {
      startYear = parseInt(m[1].length === 2 ? '20' + m[1] : m[1], 10);
    }
    map.set(s.id, { slug: s.slug, name: s.name, startYear });
  }
  _seasonsById = map;
  return map;
}

// Infère l'année à partir d'un mois (1-12) et de la saison de référence.
// Convention saison belge : septembre N → août N+1.
function inferYear(month, season) {
  if (!season || !season.startYear) return new Date().getFullYear();
  return month >= 9 ? season.startYear : season.startYear + 1;
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseFrMonth(s) {
  return MONTHS_FR[normalize(s).replace(/\.$/, '')] || null;
}

// Extrait la première paire (date FR, heure HH:MM) du bloc principal
// de la fiche. Format : "SA 06 JUIN" + "20:15" dans des spans adjacents
// d'une zone .sl-date.
function parseDetailDateTime(html, season) {
  const $ = cheerio.load(html);
  // Tente d'abord .sl-date (bloc principal du hero)
  const scopes = [$('.sl-date').first(), $('body')];
  for (const $scope of scopes) {
    if (!$scope.length) continue;
    const text = $scope.text().replace(/\s+/g, ' ');
    const m = text.match(/(?:LU|MA|ME|JE|VE|SA|DI)\s+(\d{1,2})\s+([A-ZÉÛÔ]+)\s+(\d{1,2}):(\d{2})/);
    if (m) {
      const day = m[1].padStart(2, '0');
      const month = parseFrMonth(m[2]);
      if (!month) continue;
      const year = inferYear(month, season);
      return {
        date: `${year}-${String(month).padStart(2, '0')}-${day}`,
        time: `${m[3].padStart(2, '0')}:${m[4]}`,
      };
    }
  }
  return { date: null, time: null };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, slug, time) {
  const t = time ? `-${time.replace(':', '')}` : '';
  return `senghor-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeSenghor({} = {}) {
  const composerIndex = await loadComposerIndex();
  const seasonsById = await loadSeasons();
  const today = isoToday();

  // 1) Récupère tous les projects filtrés par discipline
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const url = `${BASE_URL}/wp-json/wp/v2/project?per_page=${PER_PAGE}&page=${page}&field=${API_FIELDS}&orderby=date&order=desc`;
    console.error(`[senghor] page ${page} ${url}`);
    let batch;
    try { batch = await fetchJson(url); }
    catch (err) {
      console.error(`[senghor]   page ${page} failed: ${err.message}`);
      break;
    }
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    if (batch.length < PER_PAGE) break;
    await sleep(180);
  }
  console.error(`[senghor] ${all.length} projects récupérés via API`);

  // 2) Pour chaque project, fetch detail + parse date+time
  const concerts = [];
  let past = 0, noDate = 0;
  for (const p of all) {
    const title = decodeEntities(p.title && p.title.rendered || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const url = p.link;
    if (!title || !url) continue;

    // Saison de référence (pour inférer l'année)
    const seasonId = (p.season || [])[0];
    const season = seasonId ? seasonsById.get(seasonId) : null;

    let html;
    try { html = await fetchHtml(url); }
    catch (err) {
      console.error(`[senghor]   détail ${url} failed: ${err.message}`);
      continue;
    }
    const { date, time } = parseDetailDateTime(html, season);
    if (!date) { noDate++; continue; }
    if (date < today) { past++; continue; }

    // Extrait l'excerpt depuis le HTML détail comme program
    const $ = cheerio.load(html);
    const description = decodeEntities($('meta[name="description"]').attr('content') || '').replace(/\s+/g, ' ').trim();
    // Catégorie depuis class_list (taxonomie field)
    const fieldClass = (p.class_list || []).find((c) => c.startsWith('field-'));
    const discipline = fieldClass ? fieldClass.replace('field-', '').replace(/-/g, ' ') : '';

    const composers = matchComposers(`${title} ${description.slice(0, 1500)}`, composerIndex);
    concerts.push({
      id: buildId(date, p.slug, time),
      source: 'senghor',
      venue_id: 'espace-senghor-etterbeek',
      title,
      date,
      time,
      url,
      composers,
      performers: [],
      program: [discipline, description.slice(0, 200)].filter(Boolean).join(' — ') || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
    await sleep(180);
  }

  console.error(`[senghor] retenus ${concerts.length} | passés ${past} | sans date ${noDate}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeSenghor()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
