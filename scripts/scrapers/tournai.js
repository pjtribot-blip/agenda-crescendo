// Scraper Maison de la Culture de Tournai
//
// Stratégie :
//  1. Liste : /programme (Drupal) renvoie ~150 événements en pleine page,
//     un par <div class="views-row"> dans la vue `view-programme`. Chaque
//     carte contient date (DD.MM.YYYY), titre, discipline (Drupal taxonomy)
//     et lieu.
//  2. Filtre éditorial strict : on ne garde que les événements taggés
//     "musique" en discipline. La Maison de la Culture étant
//     pluridisciplinaire (théâtre, danse, cirque…), c'est le seul moyen
//     de filtrer côté liste.
//  3. Sous-filtre titre : la rubrique "musique" inclut chanson, jazz,
//     world. On rejette par titre les motifs clairement non savants.
//     C'est faillible — à raffiner manuellement si du bruit apparaît.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://maisonculturetournai.com';
const LIST_PATH = '/programme';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// La discipline "musique" est trop large à Tournai : on filtre les
// titres clairement non-classiques.
const TITLE_REJECT_PATTERNS = [
  /\bbrel\b/i,
  /chanson/i,
  /\byael naim\b/i,
  /\bbenjamin biolay\b/i,
  /\banne roumanoff\b/i,
  /\belie semoun\b/i,
  /\bcactus\b/i,
  /afterwork/i,
  /\bworld\b/i,
  /\bjazz\b/i,
  /\bsoul\b/i,
  /\bfunk\b/i,
  /\bpop\b/i,
  /\brock\b/i,
  /\brap\b/i,
  /\bélectro\b/i,
  /\bélectronique\b/i,
  /\belectronique\b/i,
  /\bvinyles\b/i,
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

  $('.view-programme .views-row').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a[href^="/programme/"]').first();
    const href = $a.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;

    const title = $el.find('.title, h3.title, h3').first().text().trim().replace(/\s+/g, ' ');
    const dateText = $el.find('.date').first().text().trim().replace(/\s+/g, ' ');
    const dm = dateText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!dm) return;
    const date = `${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`;

    const disciplines = $el.find('.field--name-field-discipline .field__item').toArray()
      .map((d) => normalize($(d).text()));
    const lieu = $el.find('.field--name-field-lieu .field__item').first().text().trim();

    items.push({ url, title, date, disciplines, lieu });
  });

  return items;
}

function isAllowed(item) {
  // Doit avoir "musique" en discipline
  if (!item.disciplines.includes('musique')) return false;
  // Et ne pas matcher un motif non-classique connu
  if (TITLE_REJECT_PATTERNS.some((re) => re.test(item.title))) return false;
  return true;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/programme\/([^/?#]+)/) || [])[1] || 'event';
  return `tournai-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeTournai({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[tournai] list ${url}`);
  const html = await fetchHtml(url);
  let listed = parseListPage(html);

  // Dédupe par (url, date)
  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  const allowed = upcoming.filter(isAllowed);
  const musicTotal = upcoming.filter((it) => it.disciplines.includes('musique')).length;
  console.error(`[tournai] ${listed.length} listés / ${upcoming.length} à venir / ${musicTotal} taggés musique / ${allowed.length} retenus (filtre titre)`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers(it.title, composerIndex);
    return {
      id: buildId(it.date, it.url),
      source: 'tournai',
      venue_id: 'mctournai',
      title: it.title,
      date: it.date,
      time: null,
      url: it.url,
      composers,
      performers: [],
      program: it.lieu || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[tournai] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeTournai()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
