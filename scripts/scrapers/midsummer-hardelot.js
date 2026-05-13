// Scraper Théâtre élisabéthain du Château d'Hardelot
//
// Programmation 2026 incluant le Midsummer Festival (10e édition,
// fin juin - début juillet 2026 typiquement). Le festival n'est
// pas annoncé comme tel sur l'agenda — on récupère tous les
// concerts/opéras de la saison et on laisse festivals.json tagger
// ceux qui tombent dans la fenêtre Midsummer.
//
// Site : Drupal (visible aux meta + structure list-agenda__item).
// Agenda paginé : /agenda-6, /agenda-6?page=1, ...
//
// Chaque carte (.views-row.teaser--event) expose :
//   .day .month .year   → date (1 jour ; "Du DD mois au DD mois"
//                          dans le header pour les événements multi-jours)
//   .tag__name          → type (Concert, Opéra, Théâtre, Visite,
//                          Conférence, Spectacle…)
//   h3                  → titre
//   a.stretched-link    → URL fiche
//
// Filtre éditorial : on garde Concert + Opéra + Récital. On exclut
// Théâtre (Shakespeare en VO/VF), Visite, Conférence, Spectacle
// (cabaret élisabéthain, etc.).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.chateau-hardelot.fr';
const LIST_PATH = '/agenda-6';
const MAX_PAGES = 5;

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const KEEP_TYPES = new Set(['concert', 'opera', 'opéra', 'récital', 'recital', 'lecture musicale']);

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  janv: 1, fev: 2, févr: 2, avr: 4, juill: 7, aou: 8, sept: 9, sep: 9,
  oct: 10, nov: 11, dec: 12, déc: 12, février: 2, août: 8, décembre: 12,
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
    .toLowerCase()
    .trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014',
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
// Parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.views-row.teaser--event, .views-row .teaser--event').each((_, el) => {
    const $el = $(el);
    const day = $el.find('.list-agenda__item__dates__select__day .day').first().text().trim();
    const month = $el.find('.list-agenda__item__dates__select__month .month').first().text().trim();
    const year = $el.find('.list-agenda__item__dates__select__month .year').first().text().trim();
    if (!day || !month || !year) return;
    const monthNum = MONTHS_FR[normalize(month)];
    if (!monthNum) return;
    const date = `${year}-${String(monthNum).padStart(2, '0')}-${day.padStart(2, '0')}`;

    const tag = decodeEntities($el.find('.tag__name').first().text().trim()).replace(/\s+/g, ' ');
    const title = decodeEntities($el.find('h3').first().text().trim()).replace(/\s+/g, ' ');
    const href = $el.find('a.stretched-link, a.list-agenda__item__link').first().attr('href') || '';
    if (!href || !title) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    items.push({ url, title, date, tag });
  });
  return items;
}

// JSON-LD detail : startDate ISO 8601 → time
function parseDetailTime(html) {
  const $ = cheerio.load(html);
  let time = null, description = '';
  $('script[type="application/ld+json"]').each((_, s) => {
    if (time) return;
    const raw = $(s).contents().text();
    if (!raw.includes('"Event"')) return;
    try {
      const data = JSON.parse(raw);
      const candidates = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const c of candidates) {
        if (c && c['@type'] === 'Event' && c.startDate) {
          const m = c.startDate.match(/T(\d{2}):(\d{2})/);
          if (m) time = `${m[1]}:${m[2]}`;
          if (c.description) description = c.description;
          break;
        }
      }
    } catch {}
  });
  return { time, description };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url, time) {
  const slug = (url.match(/\/([^/?#]+)$/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `hardelot-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeHardelot({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const allItems = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const url = p === 0 ? `${BASE_URL}${LIST_PATH}` : `${BASE_URL}${LIST_PATH}?page=${p}`;
    console.error(`[hardelot] page ${p} ${url}`);
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.error(`[hardelot]   page ${p} failed: ${err.message}`);
      break;
    }
    const items = parseListPage(html);
    if (!items.length) break;
    allItems.push(...items);
    await sleep(150);
  }

  // Dédupe (url, date)
  const seen = new Set();
  const unique = allItems.filter((it) => {
    const k = `${it.url}|${it.date}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const upcoming = unique.filter((it) => it.date >= today);
  const allowed = upcoming.filter((it) => KEEP_TYPES.has(normalize(it.tag)));
  console.error(`[hardelot] ${unique.length} cartes / ${upcoming.length} à venir / ${allowed.length} retenus (filtre type Concert/Opéra)`);

  const concerts = [];
  for (const it of allowed) {
    let time = null, description = '';
    try {
      const html = await fetchHtml(it.url);
      const parsed = parseDetailTime(html);
      time = parsed.time;
      description = parsed.description;
    } catch (err) {
      console.error(`[hardelot]   détail ${it.url} échec : ${err.message}`);
    }
    const composers = matchComposers(`${it.title} ${description.slice(0, 1500)}`, composerIndex);
    concerts.push({
      id: buildId(it.date, it.url, time),
      source: 'hardelot',
      venue_id: 'chateau-hardelot',
      title: it.title,
      date: it.date,
      time,
      url: it.url,
      composers,
      performers: [],
      program: it.tag ? `${it.tag}${description ? ' — ' + description.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 180) : ''}` : (description.slice(0, 200) || null),
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
    await sleep(200);
  }

  console.error(`[hardelot] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeHardelot()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
