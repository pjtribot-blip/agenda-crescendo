// Scraper Opéra de Lille
//
// Stratégie :
//  1. Liste : on récupère toutes les saisons publiées (`/saison-25-26/`,
//     `/saison-26-27/` quand publié). Chaque page liste ~30-40 productions
//     dans des <article class="spec_card"> avec catégorie, titre,
//     sous-titre, plage de dates et URL de fiche.
//  2. Filtre éditorial : on ne garde que les catégories musicales
//     (opéra, opéra itinérant, concert, ballet, danse-théâtre) + les
//     coquilles "hors les murs" / "évènement" / "performance" qui
//     correspondent souvent à un récital ou à un opéra léger. On rejette
//     "sieste" / "heure bleue" / "insomniaque" / "open week" /
//     "en famille" / "danse" pure (chorégraphie sans orchestre live).
//  3. Détail : pour chaque production gardée, on visite la page fiche
//     pour récupérer toutes les dates individuelles. La fiche embarque
//     un calendrier global avec des conteneurs `calendrier-YYYY-MM-DD`
//     listant chaque représentation. On filtre les dates sur le slug
//     du spectacle courant (date-line-link href) pour éviter de capter
//     les autres productions affichées dans le même calendrier.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.opera-lille.fr';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// "sieste", "heure bleue", "insomniaque", "en famille" sont des FORMATS
// (sieste musicale, concert de chambre nocturne, opéra famille…) pas
// des genres : la programmation reste musicale/classique. On les garde.
const KEEP_CATEGORIES = new Set([
  'opera', 'opera itinerant',
  'concert',
  'ballet', 'ballet symphonique',
  'recital', 'recital lyrique',
  'evenement', 'hors-les-murs', 'hors les murs',
  'sieste', 'heure bleue', 'insomniaque',
  'en famille',
]);

// Catégories non musicales à écarter
const REJECT_CATEGORIES = new Set([
  'open week', // semaine portes ouvertes
  'danse', // danse contemporaine sans orchestre live
  'danse-theatre',
  'performance', // performance plasticienne
  'avec vous !', // bord de scène / discussions
]);

// Slugs de saisons à scanner (ordre = priorité d'affichage)
const SEASON_SLUGS = ['saison-25-26', 'saison-26-27', 'saison-24-25'];

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
      if (res.status === 404) return null;
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
// Saison page parsing
// ------------------------------------------------------------------
function parseSeasonPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('article.spec_card').each((_, el) => {
    const $el = $(el);
    if ($el.hasClass('passed')) return; // production passée
    const $a = $el.find('a.spec_lien').first();
    const href = $a.attr('href') || '';
    if (!href || !href.includes('/spectacle/')) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    const cat = $el.find('.spec_cat').first().text().trim();
    const title = $el.find('.spec_title').first().text().trim().replace(/\s+/g, ' ');
    const subtitle = $el.find('.spec_subtitle').first().text().trim().replace(/\s+/g, ' ');
    const dateRange = $el.find('.spec_dates').first().text().trim().replace(/\s+/g, ' ');
    items.push({ url, cat, title, subtitle, dateRange });
  });
  return items;
}

function isAllowed(item) {
  const c = normalize(item.cat || '');
  if (REJECT_CATEGORIES.has(c)) return false;
  if (KEEP_CATEGORIES.has(c)) return true;
  // Inconnu : on garde par défaut (Opéra de Lille programme rarement
  // hors musical) mais on signale.
  return true;
}

// ------------------------------------------------------------------
// Detail page parsing → toutes les dates individuelles du spectacle
// ------------------------------------------------------------------
function parseDetailDates(html, spectacleUrl) {
  const $ = cheerio.load(html);
  const slug = (spectacleUrl.match(/\/spectacle\/([^/?#]+)/) || [])[1] || '';
  const dates = new Map(); // date → time set
  $('.calendrier-dates-container').each((_, container) => {
    const $c = $(container);
    const klass = $c.attr('class') || '';
    const dm = klass.match(/calendrier-(\d{4}-\d{2}-\d{2})/);
    if (!dm) return;
    const date = dm[1];
    // Ne garder que les date-line qui pointent vers notre spectacle
    $c.find('.date-line a.date-line-link').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.includes(`/spectacle/${slug}`)) return;
      // Évite les bord de scène / discussions (cat "avec vous !")
      const cat = normalize($(a).find('.date-line-categorie').first().text().trim());
      if (REJECT_CATEGORIES.has(cat)) return;
      // L'heure n'est pas exposée dans le calendrier global ; on laisse null.
      if (!dates.has(date)) dates.set(date, null);
    });
  });
  return [...dates.keys()];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/spectacle\/([^/?#]+)/) || [])[1] || 'event';
  return `opl-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeOperaLille({
  detailDelay = 350,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // 1. Saisons
  const productions = new Map(); // url → meta
  for (const slug of SEASON_SLUGS) {
    const url = `${BASE_URL}/${slug}/`;
    try {
      console.error(`[opl] saison ${slug}`);
      const html = await fetchHtml(url);
      if (!html) continue;
      const items = parseSeasonPage(html);
      for (const it of items) {
        if (!productions.has(it.url)) productions.set(it.url, it);
      }
    } catch (err) {
      console.error(`[opl] saison ${slug} failed: ${err.message}`);
    }
    await sleep(300);
  }
  console.error(`[opl] ${productions.size} productions distinctes`);

  // 2. Filtre éditorial
  const allowed = [...productions.values()].filter(isAllowed);
  const rejected = productions.size - allowed.length;
  console.error(`[opl] ${allowed.length} retenues / ${rejected} rejetées (cat hors musique)`);

  // 3. Détail (cache implicite par production)
  const concerts = [];
  for (const item of allowed) {
    let dates = [];
    try {
      const html = await fetchHtml(item.url);
      if (html) dates = parseDetailDates(html, item.url);
      await sleep(detailDelay);
    } catch (err) {
      console.error(`[opl] detail failed for ${item.url}: ${err.message}`);
    }

    if (dates.length === 0) {
      console.error(`[opl] aucune date pour ${item.url} (${item.dateRange})`);
      continue;
    }

    const composers = matchComposers([item.title, item.subtitle].join(' '), composerIndex);

    for (const date of dates) {
      if (date < today) continue;
      concerts.push({
        id: buildId(date, item.url),
        source: 'opl',
        venue_id: 'operalille',
        title: item.title,
        date,
        time: null,
        url: item.url,
        composers,
        performers: [],
        program: item.subtitle || null,
        price_min: null,
        price_max: null,
        scraped_at: new Date().toISOString(),
      });
    }
  }

  console.error(`[opl] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeOperaLille()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
