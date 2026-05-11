// Scraper Chapelle Musicale Reine Elisabeth (Waterloo)
//
// La Chapelle expose un calendrier WordPress avec une archive par année :
//   /fr/calendrier/{YYYY}/   → liste de toutes les fiches /fr/evenement/{slug}/
// Chaque page détail embarque un JSON-LD schema.org/Event riche :
//   { name, startDate, endDate, location: { name, address }, description }
//
// On exploite ce JSON-LD :
//  - startDate ISO 8601 → date + time
//  - location.name → permet de détecter les concerts hors Waterloo
//    (Chapelle organise les Concerts de Midi au MIM, des galas à Bozar/
//    Flagey/Monnaie, etc.). Quand le lieu n'est pas la Chapelle, on
//    skip pour éviter le doublon avec le scraper du lieu hôte.
//
// Filtre éditorial :
//  - Hard reject : auditions internes, cours fermés (mots-clés
//    "audition interne", "cours fermé", "classe fermée").
//  - Tout le reste passe : récitals, masterclasses publiques, marathons,
//    MuCH Sundays, MuCH Surprise, gala, Horizon, Artist Diploma,
//    Concert de Nouvel An, Garden Party.
//
// Festival MuCH Waterloo : application automatique via festivals.json
// (fenêtre 17-21 juin 2026) — aucune logique ici.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://musicchapel.org';
// On scrape l'archive année courante + l'année suivante. WordPress
// renvoie 200 même sans contenu (page vide) — on tolère.
const YEARS_TO_FETCH = 2;

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Quand location.name matche un de ces patterns, le concert se tient
// chez un partenaire DÉJÀ scrapé : on skip pour éviter le doublon.
const EXTERNAL_VENUE_PATTERNS = [
  { re: /mim|mus[eé]e des instruments/i, label: 'MIM (mim.js)' },
  { re: /\bbozar\b|palais des beaux-arts/i, label: 'Bozar (bozar.js)' },
  { re: /\bflagey\b/i, label: 'Flagey (flagey.js)' },
  { re: /\bmonnaie\b|de munt/i, label: 'La Monnaie (monnaie.js)' },
  { re: /concertgebouw/i, label: 'Concertgebouw (cgbrugge.js)' },
  { re: /\bphilharmonie\s+luxembourg\b/i, label: 'Phil Lux (phillux.js)' },
];

// Hard reject : à exclure quel que soit le contexte
const TITLE_REJECT_PATTERNS = [
  /audition interne/i,
  /classe ferm[eé]e/i,
  /cours ferm[eé]/i,
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
// Year archive → liste d'URLs d'événements
// ------------------------------------------------------------------
function parseYearArchive(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $('a[href*="/evenement/"]').each((_, a) => {
    let href = $(a).attr('href') || '';
    if (!href) return;
    if (!/\/evenement\/[^/?#]+\/?$/.test(href)) return;
    if (!href.startsWith('http')) href = BASE_URL + href;
    // Normalise : trailing slash
    if (!href.endsWith('/')) href += '/';
    urls.add(href);
  });
  return Array.from(urls);
}

// ------------------------------------------------------------------
// Detail → JSON-LD schema.org/Event
// ------------------------------------------------------------------
function parseDetail(html) {
  const $ = cheerio.load(html);
  let event = null;
  $('script[type="application/ld+json"]').each((_, s) => {
    if (event) return;
    const raw = $(s).contents().text();
    if (!raw.includes('"Event"')) return;
    try {
      const data = JSON.parse(raw);
      // Le JSON-LD peut être un Event direct, ou un @graph[]
      const candidates = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const c of candidates) {
        if (c && c['@type'] === 'Event' && c.startDate) { event = c; break; }
      }
    } catch {}
  });
  return event;
}

// "2026-03-26T20:15" → { date: "2026-03-26", time: "20:15" }
function splitIsoDateTime(s) {
  if (!s) return { date: null, time: null };
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return { date: null, time: null };
  return { date: m[1], time: m[2] && m[3] ? `${m[2]}:${m[3]}` : null };
}

function detectExternalVenue(locationName) {
  if (!locationName) return null;
  for (const { re, label } of EXTERNAL_VENUE_PATTERNS) {
    if (re.test(locationName)) return label;
  }
  return null;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url, time) {
  const slug = (url.match(/\/evenement\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `chapelle-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeChapelle({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();
  const currentYear = new Date().getFullYear();

  // 1) Récupérer les URLs d'événements via les archives année courante + suivante
  const allUrls = new Set();
  for (let i = 0; i < YEARS_TO_FETCH; i++) {
    const year = currentYear + i;
    const url = `${BASE_URL}/fr/calendrier/${year}/`;
    console.error(`[chapelle] archive ${url}`);
    try {
      const html = await fetchHtml(url);
      const urls = parseYearArchive(html);
      console.error(`[chapelle]   ${urls.length} URLs trouvées`);
      for (const u of urls) allUrls.add(u);
    } catch (err) {
      console.error(`[chapelle]   ${year} indisponible : ${err.message}`);
    }
  }
  // Toujours rajouter /fr/calendrier/ courant (parfois des URLs récentes
  // n'apparaissent pas immédiatement dans l'archive année).
  try {
    const html = await fetchHtml(`${BASE_URL}/fr/calendrier/`);
    for (const u of parseYearArchive(html)) allUrls.add(u);
  } catch {}

  console.error(`[chapelle] ${allUrls.size} fiches distinctes à examiner`);

  // 2) Fetch chaque détail + parse JSON-LD
  const concerts = [];
  let parsed = 0, past = 0, skipExternal = 0, rejected = 0, noJsonLd = 0;
  for (const url of allUrls) {
    try {
      const html = await fetchHtml(url);
      const event = parseDetail(html);
      if (!event) { noJsonLd++; continue; }

      const { date, time } = splitIsoDateTime(event.startDate);
      if (!date) { noJsonLd++; continue; }
      if (date < today) { past++; continue; }

      const title = decodeEntities(event.name || '').replace(/\s+/g, ' ').trim();
      const locName = decodeEntities(event.location && event.location.name || '').trim();
      const description = decodeEntities(event.description || '').replace(/\s+/g, ' ').trim();

      // Skip si lieu hôte = partenaire déjà scrapé
      const external = detectExternalVenue(locName);
      if (external) {
        skipExternal++;
        console.error(`[chapelle]   skip ${date} ${title.slice(0,50)} (lieu ${locName} → ${external})`);
        continue;
      }

      // Hard reject titres
      if (TITLE_REJECT_PATTERNS.some((re) => re.test(title))) {
        rejected++;
        continue;
      }

      const composers = matchComposers(`${title} ${description.slice(0, 1500)}`, composerIndex);
      concerts.push({
        id: buildId(date, url, time),
        source: 'chapelle',
        venue_id: 'chapelle-reine-elisabeth',
        title,
        date,
        time,
        url,
        composers,
        performers: [],
        program: locName && !/music chapel|studio haas|salle haas/i.test(locName)
          ? `${locName}${description ? ' — ' + description.slice(0, 180) : ''}`
          : (description.slice(0, 200) || null),
        price_min: null,
        price_max: null,
        scraped_at: new Date().toISOString(),
      });
      parsed++;

      // Politesse : 200 ms entre requêtes
      await sleep(200);
    } catch (err) {
      console.error(`[chapelle]   échec ${url} : ${err.message}`);
    }
  }

  console.error(`[chapelle] retenus ${parsed} | passés ${past} | skip lieu externe ${skipExternal} | rejetés ${rejected} | sans JSON-LD ${noJsonLd}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeChapelle()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
