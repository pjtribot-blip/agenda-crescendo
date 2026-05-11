// Scraper KBR — Bibliothèque royale de Belgique
//
// API REST publique du plugin "The Events Calendar" (WordPress) :
// /wp-json/tribe/events/v1/events?lang=fr&per_page=N
// Champs disponibles : id, title, url, start_date, end_date, excerpt,
// description, categories[].name, venue.venue, cost, all_day.
//
// Filtre éditorial :
//  - On garde si la catégorie est "Concert" ou "Contes" (formats musicaux
//    proposés par la KBR).
//  - On garde aussi quel que soit le tag si le titre contient "Trésors
//    musicaux", "Polyphonies", "Récital" ou "Concert" (la KBR taggue
//    les Trésors musicaux sous "Amis du KBR museum" et les
//    Polyphonies improvisées sous "Atelier" — il faut compenser).
//  - Tout le reste (Visite guidée, Atelier, Conférence) est rejeté.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const API_URL = 'https://www.kbr.be/wp-json/tribe/events/v1/events?lang=fr&per_page=100';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const KEEP_CATEGORIES = new Set(['concert', 'contes', 'récital', 'recital']);
const KEEP_TITLE_PATTERNS = [
  /tr[eé]sors? musicaux/i,
  /polyphonies?/i,
  /r[eé]cital/i,
  /^concert\b/i,
  /\bconcert de midi\b/i,
];

// ------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------
async function fetchJson(url, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Language': 'fr-BE,fr;q=0.9',
        },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      return await res.json();
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

// Décode les entités HTML les plus courantes (les titres remontés
// par WP sont souvent encodés &#8217; ou &rsquo; etc.)
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014', eacute: 'é', egrave: 'è',
  ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô',
  iuml: 'ï', icirc: 'î', uuml: 'ü', ucirc: 'û',
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
// Filter
// ------------------------------------------------------------------
function isAllowed(title, categories) {
  if (categories.some((c) => KEEP_CATEGORIES.has(normalize(c)))) return true;
  if (KEEP_TITLE_PATTERNS.some((re) => re.test(title))) return true;
  return false;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

// "2026-05-22 12:30:00" → date "2026-05-22", time "12:30"
function splitDateTime(s) {
  if (!s) return { date: null, time: null };
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return { date: null, time: null };
  return { date: m[1], time: m[2] && m[3] ? `${m[2]}:${m[3]}` : null };
}

function buildId(date, slugUrl, time) {
  const slug = (slugUrl.match(/\/(?:evenement|agenda)\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `kbr-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeKBR({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  console.error(`[kbr] API ${API_URL}`);
  const data = await fetchJson(API_URL);
  const events = Array.isArray(data.events) ? data.events : [];
  console.error(`[kbr] ${events.length} événements API`);

  const concerts = [];
  let kept = 0, rejected = 0, past = 0;
  for (const e of events) {
    const title = decodeEntities(e.title || '').replace(/\s+/g, ' ').trim();
    const cats = (e.categories || []).map((c) => decodeEntities(c.name || ''));
    const { date, time } = splitDateTime(e.start_date);
    if (!date) continue;
    if (date < today) { past++; continue; }
    if (!isAllowed(title, cats)) { rejected++; continue; }
    kept++;

    const description = decodeEntities(e.description || e.excerpt || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const composers = matchComposers(`${title} ${description.slice(0, 1500)}`, composerIndex);
    concerts.push({
      id: buildId(date, e.url, time),
      source: 'kbr',
      venue_id: 'kbr',
      title,
      date,
      time,
      url: e.url,
      composers,
      performers: [],
      program: cats.length ? `${cats.join(' · ')} — ${description.slice(0, 200)}` : description.slice(0, 200) || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
  }

  console.error(`[kbr] retenus ${kept} | rejet catégorie ${rejected} | passés ${past}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeKBR()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
