// Scraper Antwerp Symphony Orchestra (ASO)
//
// HTML statique propre, version FR officielle. Pagination /fr/programma
// + ?page=N (~10 pages, ~8 cartes / page, ~80 concerts saison).
//
// Chaque carte <li class="eventCard"> :
//   <a class="desc" href="/fr/programma/{slug}">
//   <h3 class="title">Titre</h3>
//   <div class="supertitle">Sous-titre</div>
//   <div class="top-date">
//     <span class="start">dim. 17.05.2026</span>
//     <span class="time">15:00</span>
//   </div>
//   <div class="tagline">Description</div>
//   <div class="location">
//     <i class="fa fa-map-marker"></i>
//     AMUZ, Antwerpen
//   </div>
//   <ul class="genres">...</ul>
//
// Mapping venue (par texte de .location) :
//   "Salle Reine Elisabeth, Antwerpen" → reine-elisabeth-antwerpen
//   "AMUZ, Antwerpen"                 → amuz (existant)
//   "Opera d'Anvers"                   → operaballet-antwerpen
//   "Antwerp Symphony Orchestra"       → reine-elisabeth-antwerpen (siège)
//   Autre (tournée hors Anvers)        → skip
//
// Filtre éditorial : la programmation ASO est 100% classique. On
// rejette par titre les activités hors-concert :
//   - Lectures (conférences Govert Schilling…)
//   - Concerts familial / De Ruimtereizigers (jeune public)
//   - Activités des Amis (privées)
//   - Répétitions privées
//
// Dédoublonnage AMUZ : les concerts ASO joués à AMUZ apparaissent
// aussi dans le scraper AMUZ. On garde le côté ASO (programme + prix
// plus détaillés). aggregate.js dédupe par (date, time, normalize-title).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.antwerpsymphonyorchestra.be';
const LIST_PATH = '/fr/programma';
const MAX_PAGES = 12;

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const VENUE_MAP = [
  { re: /salle\s+reine\s+elisabeth|reine.elisabeth/i, id: 'reine-elisabeth-antwerpen' },
  { re: /\bamuz\b/i, id: 'amuz' },
  { re: /opera\s+d[\u2019']?anvers|operaballet/i, id: 'operaballet-antwerpen' },
  { re: /antwerp symphony orchestra/i, id: 'reine-elisabeth-antwerpen' },  // siège
];

const TITLE_REJECT_PATTERNS = [
  /^lecture\b/i,
  /\brep[eé]tition\b/i,
  /\bactivit[eé]\s+des\s+amis\b/i,
  /\bconcert\s+des?\s+familles?\b/i,
  /\bde\s+ruimtereizigers\b/i,
  /\bsensibilisation\b/i,
];

const MONTHS_FR_NUM = {
  '01': 1, '02': 2, '03': 3, '04': 4, '05': 5, '06': 6,
  '07': 7, '08': 8, '09': 9, '10': 10, '11': 11, '12': 12,
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
          'Accept-Language': 'fr-BE,fr;q=0.9,nl;q=0.5',
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
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
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
// Page parsing
// ------------------------------------------------------------------
// "dim. 17.05.2026" → "2026-05-17"
function parseDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const month = MONTHS_FR_NUM[m[2].padStart(2, '0')];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function parseTime(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function mapVenue(location) {
  if (!location) return null;
  for (const { re, id } of VENUE_MAP) {
    if (re.test(location)) return id;
  }
  return null;  // hors Anvers → skip
}

function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('li.eventCard').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a.desc[href*="/fr/programma/"]').first();
    const href = $a.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    const title = decodeEntities($el.find('h3.title').first().text().trim()).replace(/\s+/g, ' ');
    const supertitle = decodeEntities($el.find('.supertitle').first().text().trim()).replace(/\s+/g, ' ');
    const dateText = $el.find('.top-date .start').first().text().trim();
    const timeText = $el.find('.top-date .time').first().text().trim();
    const date = parseDate(dateText);
    const time = parseTime(timeText);
    if (!date) return;
    const location = decodeEntities($el.find('.location').first().text().trim()).replace(/\s+/g, ' ').replace(/^\W+/, '').trim();
    const tagline = decodeEntities($el.find('.tagline').first().text().trim()).replace(/\s+/g, ' ');
    if (!title) return;
    items.push({ url, title, supertitle, date, time, location, tagline });
  });
  return items;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url, time) {
  const slug = (url.match(/\/programma\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `aso-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeAntwerpSymphony({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const allItems = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = p === 1 ? `${BASE_URL}${LIST_PATH}` : `${BASE_URL}${LIST_PATH}?page=${p}`;
    console.error(`[aso] page ${p} ${url}`);
    let html;
    try { html = await fetchHtml(url); }
    catch (err) {
      console.error(`[aso]   page ${p} failed: ${err.message}`);
      break;
    }
    const items = parseListPage(html);
    if (!items.length) break;
    allItems.push(...items);
    await sleep(180);
  }

  // Dédupe (url, date, time)
  const seen = new Set();
  const unique = allItems.filter((it) => {
    const k = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const upcoming = unique.filter((it) => it.date >= today);

  let mappedOk = 0, skippedVenue = 0, skippedTitle = 0;
  const concerts = [];
  for (const it of upcoming) {
    if (TITLE_REJECT_PATTERNS.some((re) => re.test(it.title))) { skippedTitle++; continue; }
    const venueId = mapVenue(it.location);
    if (!venueId) { skippedVenue++; continue; }
    mappedOk++;
    const composers = matchComposers(`${it.title} ${it.supertitle} ${it.tagline.slice(0, 1500)}`, composerIndex);
    const programParts = [];
    if (it.supertitle) programParts.push(it.supertitle);
    if (it.location) programParts.push(it.location);
    concerts.push({
      id: buildId(it.date, it.url, it.time),
      source: 'antwerp-symphony',
      venue_id: venueId,
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: it.supertitle ? [it.supertitle] : [],
      program: programParts.join(' — ') || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
  }

  console.error(`[aso] ${unique.length} cartes / ${upcoming.length} à venir / ${concerts.length} retenus (skip lieu hors Anvers ${skippedVenue}, skip titre ${skippedTitle})`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeAntwerpSymphony()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
