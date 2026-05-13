// Scraper Festival de Stavelot — édition d'été
//
// Festival de musique de chambre dans plusieurs lieux stavelotais
// (Église Saint-Sébastien, Réfectoire des Moines de l'Abbaye, Cinéma
// Le Versailles, Collège Saint-Remacle, Centre Culturel). Aucun de ces
// lieux n'est dans nos venues — on attribue tous les concerts au
// venue_id "stavelot-festival" et on les tague `festival:
// "festival-stavelot-YYYY"` automatiquement via festivals.json (par
// fenêtre de date du festival, courante 1er août → mi-septembre).
//
// Source : https://www.festivaldestavelot.be/concerts/

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.festivaldestavelot.be';
const LIST_PATH = '/concerts/';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

// Le festival inclut des conférences, projections de films musicaux et
// masterclasses dans son agenda. On les écarte du flux concerts.
const TITLE_REJECT_PATTERNS = [
  /^conf[eé]rence/i,
  /\bcin[eé]ma musical/i,
  /^masterclass/i,
  /\bstage\b/i,
];

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
          'Accept-Language': 'fr-BE,fr;q=0.9',
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
// Date parsing
// ------------------------------------------------------------------
// "1 août 2026" → "2026-08-01"
function parseFrenchDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\s+([a-zéûàâ]+)\s+(\d{4})/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS_FR[normalize(m[2])];
  const year = parseInt(m[3], 10);
  if (!month) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseTime(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\s*[:hH]\s*(\d{2})/);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// ------------------------------------------------------------------
// List parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.event-card-wrapper').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a.event-card-item').first();
    const href = $a.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;

    const title = $el.find('.title').first().text().trim().replace(/\s+/g, ' ');
    const subtitle = $el.find('.subtitle').first().text().trim().replace(/\s+/g, ' ');
    const dateText = $el.find('.date .date').first().text().trim();
    const timeText = $el.find('.time').first().text().trim();
    const lieu = $el.find('.place').first().text().trim().replace(/\s+/g, ' ');
    const desc = $el.find('.bottom span').first().text().replace(/\s+/g, ' ').trim();

    const date = parseFrenchDate(dateText);
    const time = parseTime(timeText);
    if (!date || !title) return;

    items.push({ url, title, subtitle, date, time, lieu, desc });
  });
  return items;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/concerts\/([^/?#]+)/) || [])[1] || 'event';
  return `stavelot-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeFestivalStavelot({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[stavelot] list ${url}`);
  const html = await fetchHtml(url);
  let listed = parseListPage(html);

  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  const allowed = upcoming.filter((it) => !TITLE_REJECT_PATTERNS.some((re) => re.test(it.title)));
  console.error(`[stavelot] ${listed.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus (rejet ${upcoming.length - allowed.length} conf./cinéma/masterclass)`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers([it.title, it.subtitle, it.desc].filter(Boolean).join(' '), composerIndex);
    return {
      id: buildId(it.date, it.url),
      source: 'stavelot',
      venue_id: 'stavelot-festival',
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: [],
      program: it.subtitle || it.desc || null,
      price_min: null,
      price_max: null,
      // lieu local pour info — agrégé sous venue_id "stavelot-festival"
      // mais on garde le détail de l'église/salle dans le program si utile.
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[stavelot] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeFestivalStavelot()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
