// Scraper PBA — Palais des Beaux-Arts de Charleroi
//
// PBA est pluridisciplinaire (théâtre, danse, musique, cirque, jazz).
// Stratégie :
//  1. Liste : on s'appuie sur le filtre serveur ?category=classique et
//     ?category=lyrique. Cela écarte théâtre, danse, cirque, jazz, jeune
//     public, musiques actuelles côté serveur. On boucle sur les saisons
//     visibles (saison courante + saisons futures détectées dans le HTML).
//  2. Détail : chaque page /spectacle/SLUG/ expose une distribution propre
//     (.hero__excerpt), un bloc Programme (.shows-details__program__text)
//     et un bloc Infos (date / heure / lieu / prix). On émet un concert
//     par date des "shows-days" si plusieurs représentations.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.pba.be';
const SAISON_PATH = '/notre-saison/';
const KEEP_CATEGORIES = ['classique', 'lyrique'];

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
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
          'Accept-Language': 'fr-BE,fr;q=0.9,en;q=0.8',
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
// Date parsing
// ------------------------------------------------------------------
// "12 mai 2026" + "20:00"
function parseFrenchDate(dateStr, timeStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{1,2})\s+([a-zA-ZÀ-ÿ]+)\s+(\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS_FR[normalize(m[2]).replace(/\.$/, '')];
  const year = parseInt(m[3], 10);
  if (!month) return null;
  let time = null;
  if (timeStr) {
    const tm = timeStr.match(/(\d{1,2})\s*[:hH]\s*(\d{2})/);
    if (tm) time = `${tm[1].padStart(2, '0')}:${tm[2]}`;
  }
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time,
  };
}

// ------------------------------------------------------------------
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('.shows-card--pba').each((_, el) => {
    const $el = $(el);
    const $link = $el.find('a.shows-card__link').first();
    const href = $link.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    const title = $el.find('.shows-card__title').first().text().trim().replace(/\s+/g, ' ');
    const dateBlock = $el.find('.shows-card__date').first().text().replace(/\s+/g, ' ').trim();
    const excerpt = $el.find('.shows-card__excerpt').first().text().replace(/\s+/g, ' ').trim();
    items.push({ url, title, dateBlock, excerpt });
  });

  return items;
}

// Découvre les saisons disponibles dans le <select name="season">.
function discoverSaisons(html) {
  const $ = cheerio.load(html);
  const seasons = new Set();
  $('select[name="season"] option').each((_, el) => {
    const value = $(el).attr('value') || '';
    if (/^\d{4}-\d{4}$/.test(value)) seasons.add(value);
  });
  if (seasons.size === 0) {
    // Repli sur les liens si le <select> n'est pas exposé.
    $('a[href*="season="]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/season=(\d{4}-\d{4})/);
      if (m) seasons.add(m[1]);
    });
  }
  return Array.from(seasons);
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseDetailPage(html, composerIndex) {
  const $ = cheerio.load(html);
  const title = $('h1.hero__title').first().text().trim().replace(/\s+/g, ' ');

  // Performers (interprètes) : extrait du hero
  const excerpt = $('.hero__excerpt').first().text().replace(/\s+/g, ' ').trim();
  const performers = excerpt
    ? excerpt.split('|').map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];

  // Programme texte (compositeurs + œuvres)
  const programmeText = $('.shows-details__program__text').first()
    .text().replace(/\s+/g, ' ').trim();

  // Description
  const description = $('.shows-details__text').first()
    .text().replace(/\s+/g, ' ').trim();

  // Tarif : on cherche le bloc <div class="shows-details__infos__item__label">Prix</div>
  // suivi de <div class="shows-details__infos__item__value typeset">…</div>
  let priceMin = null;
  let priceMax = null;
  $('.shows-details__infos__item').each((_, el) => {
    const $el = $(el);
    const label = $el.find('.shows-details__infos__item__label').first().text().trim().toLowerCase();
    if (label !== 'prix') return;
    const val = $el.find('.shows-details__infos__item__value').first().text().replace(/\s+/g, ' ');
    const nums = (val.match(/\d+/g) || []).map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 500);
    if (nums.length) {
      priceMin = Math.min(...nums);
      priceMax = Math.max(...nums);
    }
  });

  // Toutes les dates (si plusieurs représentations) — chaque
  // .shows-day(s)__item porte une date+heure. Sinon on tombera sur la
  // date+heure principale.
  const dates = [];
  $('.shows-days__item, .shows-day').each((_, el) => {
    const $el = $(el);
    const dateStr = $el.find('.shows-day__date, .shows-days__item__date').first().text().trim();
    const timeStr = $el.find('.shows-day__time, .shows-days__item__time').first().text().trim();
    const parsed = parseFrenchDate(dateStr, timeStr);
    if (parsed) dates.push(parsed);
  });

  // Date principale (Infos block)
  let primary = null;
  $('.shows-details__infos__item').each((_, el) => {
    const $el = $(el);
    const label = $el.find('.shows-details__infos__item__label').first().text().trim().toLowerCase();
    const val = $el.find('.shows-details__infos__item__value').first().text().trim();
    if (label === 'date') primary = primary || {};
    if (label === 'date') primary.date = val;
    if (label === 'heure') primary = primary || {};
    if (label === 'heure') primary.time = val;
  });
  if (primary && primary.date) {
    const parsed = parseFrenchDate(primary.date, primary.time);
    if (parsed && !dates.some((d) => d.date === parsed.date && d.time === parsed.time)) {
      dates.push(parsed);
    }
  }

  // Compositeurs : prog d'abord, puis description, puis excerpt.
  let composerBlob = programmeText;
  if (!composerBlob) composerBlob = description;
  if (!composerBlob) composerBlob = excerpt;
  const composers = matchComposers(composerBlob, composerIndex);

  return { title, performers, programmeText, description, priceMin, priceMax, dates, composers };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/spectacle\/([^/?#]+)/) || [])[1] || 'event';
  return `pba-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapePBA({
  detailDelay = 350,
  pageDelay = 250,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // 1. Découverte des saisons via la page racine de la saison
  const rootHtml = await fetchHtml(`${BASE_URL}${SAISON_PATH}`);
  let seasons = discoverSaisons(rootHtml);
  // On ajoute la "saison courante" (sans param) qui correspond à la
  // saison sélectionnée par défaut. Et on garde les saisons futures.
  seasons = ['', ...seasons.filter((s) => {
    const m = s.match(/(\d{4})-(\d{4})/);
    return m && parseInt(m[2], 10) >= new Date().getFullYear();
  })];
  // Dédupe '' avec saison courante (souvent identique). On scrape les deux,
  // dédupe par URL plus tard.
  console.error(`[pba] saisons à scraper : [${seasons.map((s) => s || 'courante').join(', ')}]`);

  // 2. Listings par catégorie × saison
  let listed = [];
  for (const cat of KEEP_CATEGORIES) {
    for (const season of seasons) {
      const qs = season ? `?category=${cat}&season=${season}` : `?category=${cat}`;
      const url = `${BASE_URL}${SAISON_PATH}${qs}`;
      try {
        console.error(`[pba] list ${cat}${season ? ' ' + season : ''}`);
        const html = await fetchHtml(url);
        listed.push(...parseListPage(html).map((it) => ({ ...it, cat })));
      } catch (err) {
        console.error(`[pba] list ${cat} ${season} failed: ${err.message}`);
      }
      await sleep(pageDelay);
    }
  }

  // Dédupe par URL et écarte les brouillons CMS ("Copie de …")
  const byUrl = new Map();
  for (const it of listed) {
    if (/^copie de\b/i.test(it.title)) continue;
    if (!byUrl.has(it.url)) byUrl.set(it.url, it);
  }
  const uniques = Array.from(byUrl.values());
  console.error(`[pba] ${listed.length} listings / ${uniques.length} spectacles distincts`);

  // 3. Détail (cache par URL) + expansion par date
  const concerts = [];
  for (const item of uniques) {
    let detail = null;
    try {
      const html = await fetchHtml(item.url);
      detail = parseDetailPage(html, composerIndex);
      await sleep(detailDelay);
    } catch (err) {
      console.error(`[pba] detail failed for ${item.url}: ${err.message}`);
      continue;
    }

    // Dates : si la page détail expose des occurrences, on les utilise ;
    // sinon, on parse la date affichée sur la carte.
    let occurrences = detail.dates.length ? detail.dates : [];
    if (occurrences.length === 0) {
      // Carte : "12 mai 2026 à 20:00"
      const m = item.dateBlock.match(/(.+?\d{4})(?:\s+à\s+(\d{1,2}\s*[:hH]\s*\d{2}))?/);
      if (m) {
        const parsed = parseFrenchDate(m[1], m[2]);
        if (parsed) occurrences.push(parsed);
      }
    }

    if (occurrences.length === 0) {
      console.error(`[pba] aucune date trouvée pour ${item.url} — ignoré`);
      continue;
    }

    for (const occ of occurrences) {
      if (occ.date < today) continue;
      concerts.push({
        id: buildId(occ.date, item.url),
        source: 'pba',
        venue_id: 'pba',
        title: detail.title || item.title,
        date: occ.date,
        time: occ.time,
        url: item.url,
        composers: detail.composers || [],
        performers: detail.performers || [],
        program: detail.programmeText || detail.description || item.excerpt || null,
        price_min: detail.priceMin ?? null,
        price_max: detail.priceMax ?? null,
        scraped_at: new Date().toISOString(),
      });
    }
  }

  console.error(`[pba] ${concerts.length} concerts produits`);
  return concerts;
}

// CLI direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapePBA()
    .then((concerts) => {
      process.stdout.write(JSON.stringify(concerts, null, 2) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
