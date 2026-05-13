// Scraper Concertgebouw Brugge — agenda musique + musique de scène
//
// Stratégie :
//  1. Liste : on filtre directement à l'URL par genre (music + music+theatre)
//     en parcourant la pagination /fr/programme/term_genre_and_style=GENRE/page=N.
//     Le filtre côté serveur écarte d'office cinema, dans, families, sound art
//     (klankkunst), conférences, etc. — on n'a pas besoin de tags fins en
//     post-filtre.
//  2. Détail : pour chaque page distincte (URL /fr/page/N), on visite une
//     fois pour récupérer les sections "programme" (compositeurs + œuvres),
//     "artistes" (interprètes + rôles), et le tarif Standard. La page liste
//     une seule date par carte ; les concerts répétés produisent plusieurs
//     cartes différentes pour la même URL — on dédupe (url, date, time) puis
//     on émet un concert par occurrence.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.concertgebouw.be';
const LIST_PATH = '/fr/programme';
// Note : les valeurs de term_genre_and_style sont en anglais même sur la
// version FR du site (le site stocke le slug en anglais et localise les
// labels).
const GENRES = ['music', 'music+theatre'];

// Sous-tags qui imposent un rejet même si l'événement est dans la rubrique
// musique (jeune public ou installations passées en doublon avec klankkunst).
const REJECT_SUBTAGS = new Set([
  'families',
  'familles',
  'sound art',
  'klankkunst',
]);

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

function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// ------------------------------------------------------------------
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('article[data-component="card--wide"]').each((_, el) => {
    const $el = $(el);
    // On ignore les bannières (articles sans <time> dedans).
    const $time = $el.find('time[datetime]').first();
    if ($time.length === 0) return;

    const dt = $time.attr('datetime') || '';
    const m = dt.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!m) return;
    const date = m[1];
    const time = m[2] && m[3] ? `${m[2]}:${m[3]}` : null;

    const $a = $el.find('a[href]').first();
    const href = $a.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;

    const title = $el.find('h3').first().text().trim().replace(/\s+/g, ' ');
    const subtitle = $el.find('h4').first().text().trim().replace(/\s+/g, ' ');
    const subtags = $el.find('.c-genre-label').toArray()
      .map((s) => $(s).text().trim().toLowerCase());

    items.push({ url, date, time, title, subtitle, subtags });
  });

  // Détecte la pagination (?page=N) — on prend le N max référencé.
  const pages = new Set();
  $('a[href*="/page="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const pm = href.match(/\/page=(\d+)/);
    if (pm) pages.add(parseInt(pm[1], 10));
  });
  const maxPage = pages.size ? Math.max(...pages) : 0;

  return { items, maxPage };
}

function isAllowed(item) {
  // Sous-tag de rejet (jeune public, installation sonore parfois cataloguée
  // dans music aussi)
  return !item.subtags.some((t) => REJECT_SUBTAGS.has(t));
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseDetailPage(html, composerIndex) {
  const $ = cheerio.load(html);

  const title = $('h1').first().text().trim().replace(/\s+/g, ' ');
  const subtitle = $('h1').first().nextAll('h2').first().text().trim().replace(/\s+/g, ' ');

  // Programme : le bloc <h2>programme</h2> est suivi d'un <div ...><p>compositeurs/œuvres</p>…
  // Il y a deux versions : une "preview" (.js-toggle--content sans inverse)
  // et une version étendue. On préfère la plus longue (la complète).
  let programmeText = '';
  $('h2').each((_, el) => {
    const t = $(el).text().trim().toLowerCase();
    if (t !== 'programme') return;
    let candidate = '';
    $(el).parent().find('.js-toggle--content p, > div p').each((_, p) => {
      const txt = $(p).text().replace(/\s+/g, ' ').trim();
      if (txt.length > candidate.length) candidate = txt;
    });
    if (candidate.length > programmeText.length) programmeText = candidate;
  });

  // Artistes
  let artistesText = '';
  $('h2').each((_, el) => {
    const t = $(el).text().trim().toLowerCase();
    if (t !== 'artistes' && t !== 'artists') return;
    const txt = $(el).parent().find('p').first().text().replace(/\s+/g, ' ').trim();
    if (txt.length > artistesText.length) artistesText = txt;
  });

  // Tarif "Standard" : "30,00 € - 36,00 €" ou "20,00 €"
  let priceMin = null;
  let priceMax = null;
  $('p.u-flex strong').each((_, el) => {
    const label = $(el).text().trim().toLowerCase();
    if (!label.startsWith('standard')) return;
    const val = $(el).next('.price-from-to').text().replace(/\s+/g, ' ').trim();
    const nums = (val.match(/(\d+)(?:[.,](\d{1,2}))?/g) || [])
      .map((s) => parseInt(s.replace(',', '.'), 10))
      .filter((n) => Number.isFinite(n) && n >= 1);
    if (nums.length) {
      priceMin = priceMin === null ? Math.min(...nums) : Math.min(priceMin, ...nums);
      priceMax = priceMax === null ? Math.max(...nums) : Math.max(priceMax, ...nums);
    }
  });

  // Compositeurs : on matche en priorité dans le bloc "programme" (la liste
  // des œuvres). Le titre est exclu pour éviter les faux positifs comme
  // "The Tallis Scholars" → Thomas Tallis (l'ensemble interprète Ockeghem
  // et Josquin, pas Tallis). Si le bloc programme est vide, on retombe sur
  // le sous-titre seulement.
  let composerBlob = programmeText;
  if (!composerBlob) composerBlob = subtitle || '';
  const composers = matchComposers(composerBlob, composerIndex);

  // Performers : on garde la liste brute du bloc artistes (1-2 lignes
  // séparées par des ", " ou des sauts de ligne) en limitant la taille.
  const performers = artistesText
    ? artistesText.split(/(?:[\n;]|\s{2,}|·)/).map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];

  // Programme texte pour le frontend
  const program = programmeText || subtitle || null;

  return { title, subtitle, composers, performers, program, priceMin, priceMax };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/page\/(\d+)/) || [])[1] || 'event';
  return `cgbrugge-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeConcertgebouwBrugge({
  detailDelay = 350,
  pageDelay = 250,
  pageHardCap = 30,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  let listed = [];
  for (const genre of GENRES) {
    // Page 0 d'abord pour découvrir maxPage
    const firstUrl = `${BASE_URL}${LIST_PATH}/term_genre_and_style=${genre}`;
    try {
      console.error(`[cgbrugge] list ${genre} page 0`);
      const firstHtml = await fetchHtml(firstUrl);
      const first = parseListPage(firstHtml);
      listed.push(...first.items);

      const lastPage = Math.min(first.maxPage, pageHardCap);
      for (let p = 1; p <= lastPage; p++) {
        const url = `${BASE_URL}${LIST_PATH}/term_genre_and_style=${genre}/page=${p}`;
        console.error(`[cgbrugge] list ${genre} page ${p}`);
        try {
          const html = await fetchHtml(url);
          const parsed = parseListPage(html);
          listed.push(...parsed.items);
        } catch (err) {
          console.error(`[cgbrugge] list ${genre} page ${p} failed: ${err.message}`);
        }
        await sleep(pageDelay);
      }
    } catch (err) {
      console.error(`[cgbrugge] list ${genre} page 0 failed: ${err.message}`);
    }
    await sleep(pageDelay);
  }

  // Dédupe sur (url, date, time)
  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Filtre dates futures + sous-tags rejetés
  const upcoming = listed.filter((it) => it.date >= today);
  const allowed = upcoming.filter(isAllowed);
  console.error(`[cgbrugge] ${listed.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus`);

  // Détail (cache par URL)
  const detailCache = new Map();
  const concerts = [];
  for (const item of allowed) {
    let detail = detailCache.get(item.url);
    if (!detail) {
      try {
        const html = await fetchHtml(item.url);
        detail = parseDetailPage(html, composerIndex);
        detailCache.set(item.url, detail);
        await sleep(detailDelay);
      } catch (err) {
        console.error(`[cgbrugge] detail failed for ${item.url}: ${err.message}`);
        detail = null;
      }
    }

    concerts.push({
      id: buildId(item.date, item.url),
      source: 'cgbrugge',
      venue_id: 'concertgebouwbrugge',
      title: detail?.title || item.title,
      date: item.date,
      time: item.time,
      url: item.url,
      composers: detail?.composers || [],
      performers: detail?.performers || [],
      program: detail?.program || item.subtitle || item.title,
      price_min: detail?.priceMin ?? null,
      price_max: detail?.priceMax ?? null,
      scraped_at: new Date().toISOString(),
    });
  }

  console.error(`[cgbrugge] ${concerts.length} concerts produits`);
  return concerts;
}

// CLI direct execution: print JSON to stdout (logs go to stderr)
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeConcertgebouwBrugge()
    .then((concerts) => {
      process.stdout.write(JSON.stringify(concerts, null, 2) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
