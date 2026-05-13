// Scraper Ferme du Biéreau (Louvain-la-Neuve)
//
// Le site officiel est sur laferme.be (Odoo). La page /events liste les
// événements à venir avec un .badge par tag (Musique classique, Midzik,
// Indie rock, Pop, Chanson française, Jazz, etc.). Nous gardons les
// tags clairement classiques :
//  - "Musique classique"
//  - "Midzik" (série de concerts de chambre acoustique propre à la Ferme)
// Tout le reste (jazz, pop, chanson, world) est rejeté — la consigne
// éditoriale Crescendo est stricte sur Biéreau.
//
// La pagination ne semble pas exposée publiquement (les events affichés
// sont en général sur 2-3 mois glissants). On accepte cette limite.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.laferme.be';
const LIST_PATH = '/events';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const KEEP_BADGES = new Set([
  'musique classique',
  'midzik',
  'classique',
  'baroque',
  'opera',
  'recital',
]);

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
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('article').each((_, el) => {
    const $el = $(el);
    const $start = $el.find('meta[itemprop="startDate"]').first();
    const startContent = $start.attr('content') || '';
    const dm = startContent.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
    if (!dm) return;
    const date = dm[1];
    const time = `${dm[2]}:${dm[3]}`;

    const $title = $el.find('.card-title, h3, h4').first();
    const title = $title.text().trim().replace(/\s+/g, ' ');

    // URL : l'<article> est wrappé dans un <a class="text-decoration-none">
    let href = $el.parent('a').attr('href') || '';
    if (!href) href = $el.find('a[href*="/event/"]').first().attr('href') || '';
    if (!href) return;
    if (href.includes('/register')) href = href.replace(/\/register\/?$/, '');
    const url = href.startsWith('http') ? href : BASE_URL + href;

    const badges = $el.find('.badge').toArray().map((b) => normalize($(b).text().trim().replace(/\s+/g, ' ')));

    items.push({ url, title, date, time, badges });
  });

  return items;
}

function isAllowed(item) {
  return item.badges.some((b) => KEEP_BADGES.has(b));
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/event\/([^/?#]+)/) || [])[1] || 'event';
  return `biereau-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeFermeDuBiereau({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[biereau] list ${url}`);
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
  const allowed = upcoming.filter(isAllowed);
  const rejected = upcoming.length - allowed.length;
  console.error(`[biereau] ${listed.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus (rejet ${rejected} : jazz/chanson/pop/world hors classique)`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers(it.title, composerIndex);
    return {
      id: buildId(it.date, it.url),
      source: 'biereau',
      venue_id: 'biereau',
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: [],
      program: it.badges.join(' · ') || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[biereau] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeFermeDuBiereau()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
