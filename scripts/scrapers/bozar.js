// Scraper Bozar — agenda classique
//
// Stratégie :
//  1. Liste : on itère sur les pages /fr/calendar?section=527&from=...&to=...&page=N
//     en suivant la pagination jusqu'à épuisement.
//  2. Filtre éditorial : on garde un événement si sa taxonomy contient au
//     moins un terme "classique" (Musique classique, ancienne, récital,
//     musique de chambre, orchestres, violoncelle, piano…) ET aucun terme
//     blacklisté (Jazz, Global Music, Musique électronique).
//  3. Détail : pour chaque événement gardé, on visite /fr/calendrier/<slug>
//     pour récupérer la date réelle (qui n'apparaît pas dans la liste),
//     l'heure, le programme, les artistes et les tarifs.
//  4. On extrait les compositeurs depuis la page détail (blocs artwork-list)
//     en repli sur un matching par alias dans le texte si rien n'a été trouvé.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.bozar.be';
const LIST_PATH = '/fr/calendar';
const SECTION_CONCERTS = 527;

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Taxonomy IDs Bozar — listés dans la facette du calendrier
const CLASSICAL_KEEP = new Set([
  515,    // Musique classique
  539,    // Musique ancienne
  936791, // Récital
  936807, // Musique de chambre
  531,    // Orchestres internationaux
  936789, // Symphonique / orchestres (déduit)
  568,    // Violoncelle (Concours Reine Elisabeth)
  565,    // Piano (le plus souvent classique chez Bozar)
  569,    // ECHO Rising Stars (récitals classiques)
]);
const BLACKLIST = new Set([
  517,    // Jazz
  937083, // Global Music
  516,    // Musique électronique
  528,    // Expositions
  546,    // Films
  521,    // Performances
  936809, // Rencontres & Débats
]);

const MONTHS_FR = {
  jan: 1, janv: 1, février: 2, fev: 2, fév: 2, févr: 2, fevr: 2, mar: 3, mars: 3,
  avr: 4, avril: 4, mai: 5, juin: 6, juil: 7, juill: 7, juillet: 7,
  aout: 8, août: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, déc: 12, déec: 12, dec: 12,
};

// Bozar attribue parfois un interprète historique comme "compositeur"
// dans le bloc artwork-list (ex. Julie Andrews créditée pour les
// "Chansons" reprises par Lea Desandre dans Chasing Rainbows). On
// liste ici les noms à NE PAS taguer comme compositeur, même quand ils
// apparaissent dans la rubrique programme.
const NON_COMPOSER_NAMES = new Set([
  'julie andrews',
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

// ------------------------------------------------------------------
// Date parsing
// ------------------------------------------------------------------
// Bozar affiche les dates au format "  8 Oct.'26" ou "26 Mai'26"
function parseBozarDate(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\.?\s*['\u2019]?\s*(\d{2,4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monRaw = m[2].toLowerCase().replace(/\.$/, '');
  const month = MONTHS_FR[monRaw] ?? MONTHS_FR[monRaw.slice(0, 3)];
  if (!month) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseBozarTime(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\s*[:hH]\s*(\d{2})/);
  if (!m) return null;
  return `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}`;
}

// ------------------------------------------------------------------
// Composer detection
// ------------------------------------------------------------------
let _composerIndex = null;
async function loadComposerIndex() {
  if (_composerIndex) return _composerIndex;
  const path = resolve(REPO_ROOT, 'data', 'composers-reference.json');
  const json = JSON.parse(await readFile(path, 'utf8'));
  // Build (canonicalName, aliasNormalized) pairs, longest first to match
  // multi-word names before single-word ones.
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

function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('article.node--type-event').each((_, el) => {
    const $el = $(el);
    const href = $el.find('a.card-link').first().attr('href');
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;

    const title = $el.find('.card-link .field--name-title').first().text().trim()
      || $el.find('.card-title .field--name-title').first().text().trim();
    const teaser = $el.find('.card-teaser').first().text().trim().replace(/\s+/g, ' ');
    const cancelled = $el.hasClass('is-cancelled');

    const taxonomyIds = [];
    $el.find('.taxonomy-term[id]').each((_, t) => {
      const m = $(t).attr('id').match(/taxonomy-term-(\d+)/);
      if (m) taxonomyIds.push(parseInt(m[1], 10));
    });

    // Card-level "À partir de XX €" pour le prix mini en repli
    const priceText = $el.find('.card-price').first().text().trim();
    const priceMinList = (priceText.match(/(\d+)\s*€/) || [])[1];

    items.push({
      url,
      title,
      teaser,
      cancelled,
      taxonomyIds,
      priceMinList: priceMinList ? parseInt(priceMinList, 10) : null,
    });
  });

  // Pagination (page=N links)
  const pageLinks = new Set();
  $('.agenda-page__pagination a[href*="page="]').each((_, a) => {
    const href = $(a).attr('href');
    const m = href.match(/page=(\d+)/);
    if (m) pageLinks.add(parseInt(m[1], 10));
  });
  const maxPage = pageLinks.size ? Math.max(...pageLinks) : 0;

  return { items, maxPage };
}

function isClassical(taxonomyIds) {
  if (taxonomyIds.some((id) => BLACKLIST.has(id))) return false;
  if (taxonomyIds.some((id) => CLASSICAL_KEEP.has(id))) return true;
  return false;
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseDetailPage(html, listEntry, composerIndex) {
  const $ = cheerio.load(html);

  // Title
  const title = $('.event-infos__name h1').first().text().trim() || listEntry.title;

  // Date / time
  const dateBlock = $('.event-infos__date p').last().text().trim();
  const date = parseBozarDate(dateBlock);
  const time = parseBozarTime(dateBlock);

  // Subtitle / program summary (h2 inside description)
  const subtitle = $('.event-description__subtitle').first().text().trim().replace(/\s+/g, ' ');

  // Performers — chaque bloc .event-page__artist contient le nom et le rôle
  const performers = [];
  $('.event-page__artist').each((_, el) => {
    const $el = $(el);
    const name = $el.find('.event-page__artists-first_part .node--type-artist').first().text().trim().replace(/\s+/g, ' ');
    const role = $el.find('.event-page__artists-second_part').first().text().trim().replace(/\s+/g, ' ');
    if (name) performers.push(role ? `${name} (${role})` : name);
  });

  // Programme structuré : artwork-list (composer + œuvre)
  const composersFromProgram = new Set();
  const programLines = [];
  $('article.node--type-artwork').each((_, el) => {
    const $el = $(el);
    const composerName = $el.find('.artwork-list__artists .node--type-artist').first().text().trim();
    const work = $el.find('.artwork-list__description').first().text().trim();
    if (composerName) {
      const isExcluded = NON_COMPOSER_NAMES.has(normalize(composerName).trim());
      if (!isExcluded) {
        // canonicalize via reference
        const matches = matchComposers(composerName, composerIndex);
        if (matches.length) {
          matches.forEach((c) => composersFromProgram.add(c));
        } else {
          composersFromProgram.add(composerName);
        }
      }
    }
    if (composerName && work) programLines.push(`${composerName} : ${work}`);
    else if (work) programLines.push(work);
  });

  // Composers fallback : matcher contre titre + sous-titre + teaser
  let composers = Array.from(composersFromProgram);
  if (composers.length === 0) {
    const blob = [title, subtitle, listEntry.teaser].filter(Boolean).join(' ');
    composers = matchComposers(blob, composerIndex);
  }

  // Programme texte : priorité au sous-titre, puis programme structuré, puis teaser
  const program = subtitle || programLines.join(' — ') || listEntry.teaser || null;

  // Tarifs : on cherche le bloc Standard (public)
  let priceMin = null;
  let priceMax = null;
  $('.event-page__rates .paragraph--type--price-type').each((_, el) => {
    const $el = $(el);
    const heading = $el.find('h4').text().trim().toLowerCase();
    if (!heading.startsWith('standard')) return;
    const priceText = $el.find('p').text();
    const nums = (priceText.match(/\d+/g) || []).map((n) => parseInt(n, 10));
    if (nums.length === 0) return;
    priceMin = Math.min(...nums);
    priceMax = Math.max(...nums);
  });
  if (priceMin === null && listEntry.priceMinList) priceMin = listEntry.priceMinList;

  return { title, date, time, subtitle, performers, composers, program, priceMin, priceMax };
}

// ------------------------------------------------------------------
// Slug → id
// ------------------------------------------------------------------
function buildId(date, url) {
  const slug = (url.match(/\/calendrier\/([^/?#]+)/) || [])[1] || 'event';
  const datePart = date || 'unknown';
  return `bozar-${datePart}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function isoPlusMonths(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  d.setDate(28);
  return d.toISOString().slice(0, 10);
}

export async function scrapeBozar({
  from = isoToday(),
  to = isoPlusMonths(13),
  detailConcurrency = 3,
  detailDelay = 400,
} = {}) {
  const composerIndex = await loadComposerIndex();

  const baseUrl = `${BASE_URL}${LIST_PATH}?section=${SECTION_CONCERTS}&from=${from}&to=${to}`;

  // Fetch first page to discover pagination
  console.error(`[bozar] list page 0  ${baseUrl}`);
  const firstHtml = await fetchHtml(baseUrl);
  const first = parseListPage(firstHtml);
  let allItems = [...first.items];

  for (let p = 1; p <= first.maxPage; p++) {
    const url = `${baseUrl}&page=${p}`;
    console.error(`[bozar] list page ${p}`);
    const html = await fetchHtml(url);
    const parsed = parseListPage(html);
    allItems.push(...parsed.items);
    await sleep(300);
  }

  // Dedupe by URL (events may appear on multiple pages near boundaries)
  const seen = new Set();
  allItems = allItems.filter((it) => {
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  console.error(`[bozar] ${allItems.length} events listed`);

  const classical = allItems.filter((it) => isClassical(it.taxonomyIds));
  console.error(`[bozar] ${classical.length} kept as classical`);

  // Detail pages — fetch with limited concurrency
  const concerts = [];
  for (let i = 0; i < classical.length; i += detailConcurrency) {
    const batch = classical.slice(i, i + detailConcurrency);
    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          const html = await fetchHtml(item.url);
          const det = parseDetailPage(html, item, composerIndex);
          if (!det.date) {
            console.error(`[bozar] skipping (no date): ${item.url}`);
            return null;
          }
          return {
            id: buildId(det.date, item.url),
            source: 'bozar',
            venue_id: 'bozar',
            title: det.title,
            date: det.date,
            time: det.time,
            url: item.url,
            composers: det.composers,
            performers: det.performers,
            program: det.program,
            price_min: det.priceMin,
            price_max: det.priceMax,
            cancelled: item.cancelled || undefined,
            scraped_at: new Date().toISOString(),
          };
        } catch (err) {
          console.error(`[bozar] detail failed for ${item.url}: ${err.message}`);
          return null;
        }
      }),
    );
    concerts.push(...results.filter(Boolean));
    if (i + detailConcurrency < classical.length) await sleep(detailDelay);
  }

  console.error(`[bozar] ${concerts.length} concerts produced`);
  return concerts;
}

// CLI direct execution: print JSON to stdout (logs go to stderr)
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeBozar()
    .then((concerts) => {
      process.stdout.write(JSON.stringify(concerts, null, 2) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
