// Scraper Printemps Musical de Silly
//
// Saison étalée mars → novembre 2026, ~15 concerts dans plusieurs lieux
// hors-circuit (Château de Morval, Église de Silly, Église de Graty,
// Le Palace à Ath, etc.). Tous attribués au venue parapluie
// "silly-festival" (50.6537, 3.9292) ; le tag festival est appliqué via
// festivals.json.
//
// Stratégie :
//  1. Lister les URLs depuis /les-concerts/ — la date est encodée dans
//     le slug (ex. "2026-03-14-young-belgian-strings").
//  2. Visiter chaque page détail pour récupérer titre, sous-titre,
//     heure, lieu local et tarif depuis le h1 ("Samedi 14 mars 2026 I
//     20h I 17€") et h2/h3.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.printempsmusicalsilly.be';
const LIST_PATH = '/les-concerts/';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

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
// List parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $('a[href*="/les-concerts/2"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = href.match(/\/les-concerts\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)\/?/);
    if (m) {
      const url = href.startsWith('http') ? href : BASE_URL + href;
      urls.add(url.replace(/\/$/, '/'));
    }
  });
  return [...urls];
}

function dateFromUrl(url) {
  const m = url.match(/\/les-concerts\/(\d{4})-(\d{2})-(\d{2})-/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ------------------------------------------------------------------
// Detail parsing
// ------------------------------------------------------------------
function parseDetailPage(html, composerIndex, fallbackDate) {
  const $ = cheerio.load(html);
  // h1 : "Samedi 14 mars 2026 I 20h I 17€"
  const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim();
  // h2 : titre principal (puis 2e h2 = sous-titre / programme)
  const h2list = $('h2').toArray().map((el) => $(el).text().replace(/\s+/g, ' ').trim()).filter(Boolean);
  // h3 : lieu (puis quelques séparateurs)
  const h3list = $('h3').toArray().map((el) => $(el).text().replace(/\s+/g, ' ').trim()).filter((t) => t && !/^_+$/.test(t));

  const title = h2list[0] ? h2list[0].replace(/\s*:\s*$/, '') : '';
  const subtitle = h2list[1] || '';
  const lieu = h3list[0] || '';

  // Heure : extraite du h1
  let time = null;
  const tm = h1.match(/(\d{1,2})\s*[hH:](\d{0,2})/);
  if (tm) time = `${tm[1].padStart(2,'0')}:${(tm[2] || '00').padStart(2,'0')}`;

  // Prix : extrait du h1 ("17€")
  let priceMin = null;
  let priceMax = null;
  const pm = h1.match(/(\d+)\s*€/);
  if (pm) { priceMin = parseInt(pm[1], 10); priceMax = priceMin; }

  const composers = matchComposers([title, subtitle].filter(Boolean).join(' '), composerIndex);

  return {
    title: title || subtitle || '(sans titre)',
    subtitle,
    lieu,
    time,
    priceMin,
    priceMax,
    composers,
  };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/les-concerts\/([^/?#]+)/) || [])[1] || 'event';
  return `silly-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeFestivalSilly({
  detailDelay = 350,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const listUrl = `${BASE_URL}${LIST_PATH}`;
  console.error(`[silly] list ${listUrl}`);
  const listHtml = await fetchHtml(listUrl);
  const urls = parseListPage(listHtml);
  console.error(`[silly] ${urls.length} URLs distinctes`);

  const concerts = [];
  for (const url of urls) {
    const date = dateFromUrl(url);
    if (!date || date < today) continue;
    try {
      const html = await fetchHtml(url);
      const detail = parseDetailPage(html, composerIndex, date);
      await sleep(detailDelay);
      concerts.push({
        id: buildId(date, url),
        source: 'silly',
        venue_id: 'silly-festival',
        title: detail.title,
        date,
        time: detail.time,
        url,
        composers: detail.composers,
        performers: [],
        program: [detail.subtitle, detail.lieu].filter(Boolean).join(' — ') || null,
        price_min: detail.priceMin,
        price_max: detail.priceMax,
        scraped_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[silly] detail failed for ${url}: ${err.message}`);
    }
  }

  console.error(`[silly] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeFestivalSilly()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
