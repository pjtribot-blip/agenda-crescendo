// Scraper Wilde Westen (Courtrai / Kortrijk, Belgique)
//
// Centre de musique pointu accueillant le volet courtraisien du
// Festival van Vlaanderen. Programmation pluridisciplinaire avec
// genres Hiphop / Rock-Pop / Klassiek-Jazz / Geluidskunst /
// Elektronica / Hard-Heavy / Party / Workshop.
//
// Stratégie : on filtre côté SERVEUR via les paramètres GET
// `genres[]=klassiek-jazz&genres[]=geluidskunst` pour limiter
// drastiquement le bruit (le filtre Klassiek/Jazz seul rate
// quelques perles minimalistes comme Terry Riley In C, classé
// "Geluidskunst" — donc on prend les deux). Les sous-rooms
// "Bolwerk", "Depart", "Concertstudio" sont des salles du même
// bâtiment → on utilise venue_id umbrella "wilde-westen-kortrijk".
//
// Chaque fiche /nl/event/{slug} expose un JSON-LD schema.org/Event
// avec name, description, startDate, endDate, location.name. Le
// format date est inhabituel ("2026-06-28CEST14:00:00+0200" avec
// le code timezone inséré au milieu) — parsing tolérant.
//
// Filtre éditorial supplémentaire titre :
//   reject DJ set / soirée club / open air party / workshop /
//          beats / nightlife
//   doute → keep (instruction utilisateur, on affine après)

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.wildewesten.be';
const LIST_PATH = '/nl/agenda';
const FILTER_QS = 'genres%5B%5D=klassiek-jazz&genres%5B%5D=geluidskunst';
const MAX_PAGES = 6;

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Workshops / DJ / soirées club ratrappent occasionnellement les
// filtres de genre — on les rejette par titre. Liste à étendre.
const TITLE_REJECT_PATTERNS = [
  /^DJ\s+/i,
  /\b(?:set|dj\s*set|after\s*party|club\s*night)\b/i,
  /open\s+air\s+(?:party|festival)/i,
  /\bworkshop\b/i,
  /\bbeats\b/i,
  /\bnightlife\b/i,
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
          'Accept-Language': 'nl-BE,nl;q=0.9,fr;q=0.7',
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
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014', eacute: 'é', egrave: 'è',
  ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô',
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
// List page parsing → event URLs
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $('a.events__item[href*="/nl/event/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    urls.add(url);
  });
  return [...urls];
}

// ------------------------------------------------------------------
// Detail page parsing → JSON-LD schema.org/Event
// ------------------------------------------------------------------
// Date format inhabituel : "2026-06-28CEST14:00:00+0200"
// → on récupère YYYY-MM-DD puis HH:MM en ignorant le bloc timezone
function parseWeirdIso(s) {
  if (!s) return { date: null, time: null };
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[^\d]*(\d{2}):(\d{2})/);
  if (!m) return { date: null, time: null };
  return { date: m[1], time: `${m[2]}:${m[3]}` };
}

function parseDetail(html) {
  const $ = cheerio.load(html);
  let evt = null;
  $('script[type="application/ld+json"]').each((_, s) => {
    if (evt) return;
    const raw = $(s).contents().text();
    if (!raw.includes('"Event"')) return;
    try {
      // L'inLanguage est valide JSON malgré le format date weird → JSON.parse OK
      const data = JSON.parse(raw);
      if (data['@type'] === 'Event' && data.startDate) evt = data;
    } catch {}
  });
  if (!evt) return null;
  const { date, time } = parseWeirdIso(evt.startDate);
  const end = parseWeirdIso(evt.endDate || '').date;
  const title = decodeEntities(evt.name || '').replace(/\s+/g, ' ').trim();
  const description = decodeEntities(evt.description || '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  const location = (evt.location && evt.location.name) || '';
  return { date, time, end, title, description, location };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url, time) {
  const slug = (url.match(/\/event\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `wildewesten-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeWildeWesten({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // 1. Récupère URLs via filtre serveur klassiek-jazz + geluidskunst
  const allUrls = new Set();
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `${BASE_URL}${LIST_PATH}?${FILTER_QS}&page=${p}`;
    console.error(`[wildewesten] page ${p} ${url}`);
    let html;
    try { html = await fetchHtml(url); }
    catch (err) {
      console.error(`[wildewesten]   page ${p} failed: ${err.message}`);
      break;
    }
    const urls = parseListPage(html);
    if (!urls.length) break;
    for (const u of urls) allUrls.add(u);
    await sleep(180);
  }
  console.error(`[wildewesten] ${allUrls.size} URLs distinctes`);

  // 2. Fetch chaque détail, parse JSON-LD
  const concerts = [];
  let past = 0, rejected = 0, noDate = 0;
  for (const url of allUrls) {
    let html;
    try { html = await fetchHtml(url); }
    catch (err) {
      console.error(`[wildewesten]   détail ${url} échec : ${err.message}`);
      continue;
    }
    const d = parseDetail(html);
    if (!d || !d.date) { noDate++; continue; }
    if (d.date < today) { past++; continue; }
    if (TITLE_REJECT_PATTERNS.some((re) => re.test(d.title))) {
      rejected++;
      console.error(`[wildewesten]   skip titre "${d.title.slice(0,50)}"`);
      continue;
    }
    const composers = matchComposers(`${d.title} ${d.description.slice(0, 1500)}`, composerIndex);
    const programParts = [];
    if (d.location) programParts.push(d.location);
    if (d.end && d.end !== d.date) programParts.push(`jusqu'au ${d.end}`);
    if (d.description) programParts.push(d.description.slice(0, 180));
    concerts.push({
      id: buildId(d.date, url, d.time),
      source: 'wildewesten',
      venue_id: 'wilde-westen-kortrijk',
      title: d.title,
      date: d.date,
      time: d.time,
      url,
      composers,
      performers: [],
      program: programParts.join(' — ').slice(0, 400) || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
    await sleep(180);
  }

  console.error(`[wildewesten] retenus ${concerts.length} | passés ${past} | reject titre ${rejected} | sans date ${noDate}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeWildeWesten()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
