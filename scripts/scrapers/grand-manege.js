// Scraper Grand Manège — Namur Concert Hall
//
// Stratégie :
//  1. Liste : la page /fr/concerts/calendrier liste TOUTES les occurrences,
//     une par <article class="card type-concert"> entouré d'un
//     <li class="cards-grid-item venue-YYYYMM"> qui encode le mois/année de
//     la représentation (le texte de date affiché est "11 mai à 16h30",
//     sans année). Pas de pagination.
//  2. Filtre éditorial : tout est musique classique chez Grand Manège.
//     On exclut juste les "ateliers musicaux parent-enfant" (atelier
//     hebdomadaire pour bébés, hors agenda éditorial).
//  3. Détail : pour chaque page concert, on visite une fois (cache par URL)
//     pour récupérer la <aside> Distribution structurée (rôle → nom) et le
//     bloc texte qui contient les compositeurs et œuvres. La page expose
//     aussi un JSON-LD MusicEvent qu'on lit en complément (description).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.grandmanege.be';
const LIST_PATH = '/fr/concerts/calendrier';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const TITLE_REJECT_PATTERNS = [
  /ateliers?\s+musicaux/i,
  /parent.*b[eé]b[eé]/i,
  // Variété, jazz pur, world music — Grand Manège loue parfois la salle
  // pour ces concerts ; hors périmètre éditorial Crescendo.
  /goldman/i,
  /aka moon/i,
  /stacey kent/i,
];

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
// "lundi 11 mai à 16h30" + monthHint "202605" → "2026-05-11" + "16:30"
function parseDateLong(text, monthHint) {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\s+([a-zA-ZÀ-ÿ]+)(?:.*?(\d{1,2})\s*[hH:](\d{0,2}))?/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monKey = normalize(m[2]).replace(/\.$/, '');
  let month = MONTHS_FR[monKey];
  if (!month && monthHint) month = parseInt(monthHint.slice(4, 6), 10);
  if (!month) return null;
  const year = monthHint ? parseInt(monthHint.slice(0, 4), 10) : new Date().getFullYear();
  const hour = m[3] ? parseInt(m[3], 10) : null;
  const minute = m[4] ? parseInt(m[4], 10) || 0 : (m[3] ? 0 : null);
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time: hour !== null ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : null,
  };
}

// ------------------------------------------------------------------
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('li.cards-grid-item').each((_, el) => {
    const $li = $(el);
    const venueMatch = ($li.attr('class') || '').match(/venue-(\d{6})/);
    if (!venueMatch) return;
    const monthHint = venueMatch[1];

    const $card = $li.find('article.card.type-concert').first();
    if ($card.length === 0) return;

    const $a = $card.find('h2.card--title a').first();
    const href = $a.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    const title = $a.text().trim().replace(/\s+/g, ' ');

    const dateText = $card.find('.time-long').first().text().trim().replace(/\s+/g, ' ');
    const parsed = parseDateLong(dateText, monthHint);
    if (!parsed) return;

    const teaser = $card.find('.card--body').first().text().trim().replace(/\s+/g, ' ');

    items.push({
      url,
      title,
      date: parsed.date,
      time: parsed.time,
      teaser,
    });
  });

  return items;
}

function isAllowed(item) {
  return !TITLE_REJECT_PATTERNS.some((re) => re.test(item.title));
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseDetailPage(html, composerIndex) {
  const $ = cheerio.load(html);

  const title = $('h1.single--title').first().text().trim().replace(/\s+/g, ' ');

  // Distribution : <aside class="single--aside"> contient un <dl> avec
  // <dt>rôle</dt><dd>nom</dd>.
  const performers = [];
  $('aside.single--aside dl').first().find('dt').each((_, dt) => {
    const role = $(dt).text().trim();
    const name = $(dt).next('dd').text().trim();
    if (name) performers.push(role ? `${name} (${role})` : name);
  });

  // Programme texte : .single--details-main .user-input (le bloc principal)
  // contient la description ET la liste des œuvres.
  const programmeText = $('.single--details-main .user-input').first()
    .text().replace(/\s+/g, ' ').trim();

  // Compositeurs : matching dans le programme. On évite le titre (les
  // ensembles type "Danish Quartet" ne sont pas des compositeurs).
  const composers = matchComposers(programmeText, composerIndex);

  return { title, performers, programmeText, composers };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/concerts\/(\d+-[^/?#]+)/) || [])[1] || 'event';
  return `gmanege-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeGrandManege({
  detailDelay = 350,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[gmanege] list ${url}`);
  const html = await fetchHtml(url);
  let listed = parseListPage(html);

  // Dédupe (url, date, time)
  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  const allowed = upcoming.filter(isAllowed);
  console.error(`[gmanege] ${listed.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus`);

  const detailCache = new Map();
  const concerts = [];
  for (const item of allowed) {
    let detail = detailCache.get(item.url);
    if (!detail) {
      try {
        const detHtml = await fetchHtml(item.url);
        detail = parseDetailPage(detHtml, composerIndex);
        detailCache.set(item.url, detail);
        await sleep(detailDelay);
      } catch (err) {
        console.error(`[gmanege] detail failed for ${item.url}: ${err.message}`);
        detail = null;
      }
    }

    concerts.push({
      id: buildId(item.date, item.url),
      source: 'gmanege',
      venue_id: 'grandmanege',
      title: detail?.title || item.title,
      date: item.date,
      time: item.time,
      url: item.url,
      composers: detail?.composers || [],
      performers: detail?.performers || [],
      program: detail?.programmeText || item.teaser || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
  }

  console.error(`[gmanege] ${concerts.length} concerts produits`);
  return concerts;
}

// CLI direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeGrandManege()
    .then((concerts) => {
      process.stdout.write(JSON.stringify(concerts, null, 2) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
