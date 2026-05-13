// Scrapers Festivals de Wallonie (Musiq3 BW + Nuits de Septembre)
//
// Le site fédératif lesfestivalsdewallonie.be utilise WebFlow CMS. Chaque
// festival a une page propre listant ses événements dans des
// `.agenda-event-items` (ou `.agenda-event-card`) avec :
//  - <a href="/fr-be/event/SLUG">
//  - <h2 class="card-heading-event">Titre</h2>
//  - <h3 class="card-heading-date">Ven. 25 sept. 26 - 20h</h3>
//  - <div class="card-heading-festival">Commune / Lieu local</div>
//
// Stratégie : scraping direct, attribution du venue_id à un parapluie
// (musiq3-bw-festival / nuits-septembre-festival). Le tag festival sera
// appliqué automatiquement par aggregate.js via festivals.json.
//
// Filtre : on rejette les conférences explicites par titre.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.lesfestivalsdewallonie.be';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const TITLE_REJECT_PATTERNS = [
  /^conf[eé]rence/i,
  /^masterclass/i,
];

const MONTHS_FR = {
  janv: 1, jan: 1, fev: 2, fév: 2, févr: 2, fevr: 2, mars: 3, mar: 3,
  avr: 4, avril: 4, mai: 5, juin: 6, juill: 7, juil: 7, juillet: 7,
  aout: 8, août: 8, sept: 9, sep: 9, oct: 10, octobre: 10,
  nov: 11, novembre: 11, dec: 12, déc: 12, decembre: 12, décembre: 12,
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
// Date parsing (FR abrégé) : "Ven. 25 sept. 26 - 20h" → 2026-09-25, 20:00
// L'année est sur 2 digits ; on ajoute 2000.
// ------------------------------------------------------------------
function parseFdwDate(s) {
  if (!s) return { date: null, time: null };
  const m = s.match(/(\d{1,2})\s+([a-zé]+)\.?\s+(\d{2,4})(?:\s*-\s*(\d{1,2})\s*[hH:](\d{0,2}))?/i);
  if (!m) return { date: null, time: null };
  const day = parseInt(m[1], 10);
  const month = MONTHS_FR[normalize(m[2]).replace(/\.$/, '')];
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  if (!month) return { date: null, time: null };
  const hour = m[4] ? parseInt(m[4], 10) : null;
  const minute = m[5] ? parseInt(m[5], 10) || 0 : (m[4] ? 0 : null);
  return {
    date: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
    time: hour !== null ? `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}` : null,
  };
}

// ------------------------------------------------------------------
// Generic FdW listing parser
// ------------------------------------------------------------------
function parseFdwPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('a.event-card[href^="/fr-be/event/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const url = href.startsWith('http') ? href : BASE_URL + href;
    const title = $el.find('.card-heading-event').first().text().trim().replace(/\s+/g, ' ');
    const dateText = $el.find('.card-heading-date').first().text().trim().replace(/\s+/g, ' ');
    const lieu = $el.find('.card-heading-festival').first().text().trim().replace(/\s+/g, ' ');
    const { date, time } = parseFdwDate(dateText);
    if (!date || !title) return;
    items.push({ url, title, date, time, lieu });
  });
  return items;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(prefix, date, url) {
  const slug = (url.match(/\/event\/([^/?#]+)/) || [])[1] || 'event';
  return `${prefix}-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Generic main
// ------------------------------------------------------------------
async function scrapeFdw({ source, venueId, festivalSlug, idPrefix }) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}/fr-be/festivals/${festivalSlug}`;
  console.error(`[${source}] list ${url}`);
  const html = await fetchHtml(url);
  const listed = parseFdwPage(html);

  const seen = new Set();
  const dedup = listed.filter((it) => {
    const key = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const upcoming = dedup.filter((it) => it.date >= today);
  const allowed = upcoming.filter((it) => !TITLE_REJECT_PATTERNS.some((re) => re.test(it.title)));
  console.error(`[${source}] ${dedup.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus`);

  return allowed.map((it) => ({
    id: buildId(idPrefix, it.date, it.url),
    source,
    venue_id: venueId,
    title: it.title,
    date: it.date,
    time: it.time,
    url: it.url,
    composers: matchComposers(it.title, composerIndex),
    performers: [],
    program: it.lieu || null,
    price_min: null,
    price_max: null,
    scraped_at: new Date().toISOString(),
  }));
}

// ------------------------------------------------------------------
// Exports
// ------------------------------------------------------------------
export async function scrapeMusiq3BW() {
  return scrapeFdw({
    source: 'musiq3-bw',
    venueId: 'musiq3-bw-festival',
    festivalSlug: 'festival-musiq3-du-brabant-wallon',
    idPrefix: 'm3bw',
  });
}

export async function scrapeNuitsSeptembre() {
  return scrapeFdw({
    source: 'nuits-septembre',
    venueId: 'nuits-septembre-festival',
    festivalSlug: 'les-nuits-de-septembre',
    idPrefix: 'nuits',
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.all([scrapeMusiq3BW(), scrapeNuitsSeptembre()])
    .then(([a, b]) => process.stdout.write(JSON.stringify([...a, ...b], null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
