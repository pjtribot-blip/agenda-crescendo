// Scraper Theater aan het Vrijthof (Maastricht — PREMIER VENUE NL)
//
// Théâtre principal de Maastricht (Vrijthof 47). Programmation
// pluridisciplinaire — classique + opéra + ballet + théâtre +
// cabaret + jeune public. Concrete CMS, billetterie Ticketmatic.
//
// L'URL des spectacles est très informative — elle encode la
// catégorie + slug + DATE-HEURE :
//   /voorstellingen/{categorie}/{titre-slug}/DD-MM-YYYY-HH-MM
// La page liste /voorstellingen contient TOUTES les occurrences
// futures (et passées récentes) avec leurs URLs complètes. On
// extrait directement date+heure du chemin sans avoir besoin de
// fetch détail.
//
// Filtre éditorial (par catégorie URL) :
//
//   KEEP par défaut :
//     klassiek-klassiek, klassiek-vocaal, klassiek-kamermuziek,
//     klassiek-orkestraal, opera
//   KEEP avec exception (ballets classiques uniquement) :
//     dans/  → seulement si titre contient un ballet de répertoire
//       (Notenkraker, Zwanenmeer, Swan Lake, Giselle, Romeo, Sleeping
//        Beauty, Coppélia, Sylphide, Bayadère, etc.) OU si compagnie
//       répertoire (Nationale Ballet, NDT 1, NDT 2, Introdans,
//       Scapino Ballet, Het Nationale Ballet van Noord-Macedonië).
//   REJECT :
//     toneel-theater, cabaret, musical-en-show, familie-en-jeugd,
//     theaterconcert, theatercollege-en-literair, jazz.
//
// Sous-filtre dans klassiek-klassiek (le tag est large à Maastricht) :
//   reject si titre contient Harmonie / Fanfare / Brass / André Rieu
//   / Vastelaovendconcert / Cabaret — typiquement musique d'harmonie
//   locale ou variétés.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.theateraanhetvrijthof.nl';
const LIST_PATH = '/voorstellingen';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const KEEP_CATEGORIES = new Set([
  'klassiek-klassiek',
  'klassiek-vocaal',
  'klassiek-kamermuziek',
  'klassiek-orkestraal',
  'opera',
]);

// Catégorie "dans" : on garde par exception si ballet de répertoire
// ou compagnie classique reconnue. Liste extensible.
const DANS_BALLET_PATTERNS = [
  /\bnotenkraker\b|nutcracker/i,
  /\bzwanenmeer\b|swan lake/i,
  /\bgiselle\b/i,
  /\bromeo\b.{0,15}\bjuli/i,
  /sleeping beauty|doornroosje/i,
  /\bcoppelia\b|coppélia/i,
  /\bsylphide\b/i,
  /\bbayadère\b|bayadere/i,
  /\bdon q?uichotte\b|don quixote/i,
  /\bla bayadère\b/i,
  /\bla fille mal gardée\b/i,
];
const DANS_COMPANY_PATTERNS = [
  /het nationale ballet/i,
  /\bndt\s*[12]?\b/i,
  /\bintrodans\b/i,
  /scapino ballet/i,
  /nationale ballet.{0,30}noord.macedoni/i,
  /staatsopera\s+ballet/i,
];

// Patterns klassiek-klassiek → sous-filtre rejet
const KLASSIEK_REJECT_PATTERNS = [
  /\bharmonie\b/i,
  /\bfanfare\b/i,
  /\bbrass\b/i,
  /\bandré\s*rieu\b|\bandre\s*rieu\b/i,
  /vastelaovend/i,             // carnaval
  /\bcabaret\b/i,
  /\bblaasmuziek\b/i,
  /pinksterconcert.{0,30}harmonie/i,
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
          'Accept-Language': 'nl-NL,nl;q=0.9,fr;q=0.7,en;q=0.5',
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

// ------------------------------------------------------------------
// Parsing list page : extract all show URLs + leur titre courant
// ------------------------------------------------------------------
// URL format : /voorstellingen/{cat}/{slug}/DD-MM-YYYY-HH-MM
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  // Map slug-produit → titre (récupéré depuis le lien sans date-suffix)
  const titleBySlug = new Map();
  $('a[href*="/voorstellingen/"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    const m = href.match(/\/voorstellingen\/([a-z][a-z-]+)\/([a-z0-9-]+)(?:\/(\d{2}-\d{2}-\d{4}-\d{2}-\d{2}))?$/);
    if (!m) return;
    const cat = m[1];
    const slug = m[2];
    const dateTimeSlug = m[3];
    const text = $a.text().trim().replace(/\s+/g, ' ');
    if (!dateTimeSlug) {
      // Lien produit générique → on enregistre le titre
      if (text && text.length > 3 && text.length < 200) {
        titleBySlug.set(`${cat}/${slug}`, decodeEntities(text));
      }
      return;
    }
    // Occurrence datée
    const [DD, MM, YYYY, hh, mm] = dateTimeSlug.split('-');
    const date = `${YYYY}-${MM}-${DD}`;
    const time = `${hh}:${mm}`;
    items.push({
      url: href.startsWith('http') ? href : BASE_URL + href,
      productKey: `${cat}/${slug}`,
      cat,
      slug,
      date,
      time,
      _titleSrc: text,  // si pas dans titleBySlug, fallback
    });
  });
  // Résoudre les titres
  for (const it of items) {
    it.title = titleBySlug.get(it.productKey) || it.slug.replace(/-/g, ' ');
  }
  return items;
}

function isAllowed(it) {
  if (KEEP_CATEGORIES.has(it.cat)) {
    // Sous-filtre appliqué à toutes les catégories classiques :
    // rejette harmonie/fanfare/carnaval/André Rieu même si tagué
    // klassiek-* ou opera (Limburg = forte tradition harmonie).
    if (KLASSIEK_REJECT_PATTERNS.some((re) => re.test(it.title))) return false;
    return true;
  }
  // Exception "dans" pour ballets de répertoire / compagnies classiques
  if (it.cat === 'dans') {
    if (DANS_BALLET_PATTERNS.some((re) => re.test(it.title))) return true;
    if (DANS_COMPANY_PATTERNS.some((re) => re.test(it.title))) return true;
    return false;
  }
  return false;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, slug, time) {
  const t = time ? `-${time.replace(':', '')}` : '';
  return `vrijthof-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeVrijthofMaastricht({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[vrijthof] list ${url}`);
  const html = await fetchHtml(url);
  let listed = parseListPage(html);

  // Dédupe (url)
  const seen = new Set();
  listed = listed.filter((it) => {
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  const allowed = upcoming.filter(isAllowed);

  const byCat = {};
  for (const a of allowed) byCat[a.cat] = (byCat[a.cat] || 0) + 1;
  console.error(`[vrijthof] ${listed.length} cartes / ${upcoming.length} à venir / ${allowed.length} retenus :`, byCat);

  const concerts = allowed.map((it) => {
    const composers = matchComposers(it.title, composerIndex);
    return {
      id: buildId(it.date, it.slug, it.time),
      source: 'vrijthof',
      venue_id: 'vrijthof-maastricht',
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: [],
      program: it.cat.replace(/-/g, ' '),
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[vrijthof] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeVrijthofMaastricht()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
