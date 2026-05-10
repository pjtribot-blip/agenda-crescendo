// Scraper De Bijloke — Muziekcentrum Gand
//
// Stratégie :
//  1. Liste : on itère /nl/programma?page=N tant qu'on récupère des
//     événements (pagination linéaire). Chaque <li class="eventCard"> a
//     URL, titre, date courte. La rubrique entière est musicale (la
//     Bijloke est un Muziekcentrum dédié), donc pas de filtre catégorie
//     côté liste.
//  2. Détail : pour chaque page produit, on extrait :
//       - le bloc dataLayer (Google Analytics) qui sérialise une liste
//         d'items, un par représentation, avec item_date, item_genres,
//         item_name, price ; c'est notre source principale ;
//       - le JSON-LD Event[] qui confirme date, lieu, prix.
//  3. Filtre éditorial : on garde si item_genres contient au moins
//     une étiquette "savante" (Klassiek, Symfonisch, Kamermuziek,
//     Oude muziek, Eigentijds, Vocaal, Lied, Opera, Jazz si jazz
//     savant — Bijloke programme du jazz contemporain de tradition
//     écrite). On rejette purement world / pop / volkmuziek seules.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.bijloke.be';
const LIST_PATH = '/nl/programma';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Tags savants (la Bijloke est large : on garde large)
const KEEP_GENRES = new Set([
  'klassiek',
  'symfonisch',
  'kamermuziek',
  'oude muziek',
  'eigentijds',
  'hedendaags',
  'vocaal',
  'lied',
  'opera',
  'jazz', // Bijloke programme un jazz fortement écrit / créatif
  'world', // Bijloke a un cycle world music savant (Naseer Shamma, Aynur…)
]);

const REJECT_GENRES = new Set([
  'pop',
  'rock',
  'volk',
  'volksmuziek',
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
          'Accept-Language': 'nl-BE,nl;q=0.9,fr;q=0.8',
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
  const urls = new Set();
  $('li.eventCard a.desc[href^="/nl/programma/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    urls.add(url);
  });
  // Fallback : tout lien /nl/programma/SLUG dans une eventCard
  $('li.eventCard a[href^="/nl/programma/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href) return;
    if (/programma\/?$/.test(href)) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    urls.add(url);
  });
  // Suivant
  const $next = $('a.btn.next, a[rel="next"]').first();
  const nextHref = $next.attr('href') || '';
  return { urls: [...urls], nextHref };
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseDetailPage(html, composerIndex) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim().replace(/\s+/g, ' ');

  // dataLayer : retrouve le JSON inline
  let detailItems = [];
  let genresSet = new Set();
  const re = /var\s+dataLayer\s*=\s*(\[[\s\S]*?\])\s*;/;
  const m = html.match(re);
  if (m) {
    try {
      const arr = JSON.parse(m[1]);
      const data = arr[0] || {};
      detailItems = data.detail_items || [];
      for (const it of detailItems) {
        for (const g of (it.item_genres || [])) {
          genresSet.add(normalize(g));
        }
      }
    } catch {}
  }

  // JSON-LD Event(s) — fallback dates si dataLayer manque
  let ldEvents = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const txt = $(el).html();
      if (!txt) return;
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      for (const e of arr) {
        if (e['@type'] === 'Event') ldEvents.push(e);
      }
    } catch {}
  });

  // Description : .description, .text, ou simplement les <p> du body
  const desc = $('.description p, .text p, article p').toArray()
    .map((p) => $(p).text().replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 30)
    .slice(0, 3)
    .join(' ');

  const composers = matchComposers(`${title} ${desc}`.slice(0, 2000), composerIndex);

  return { title, detailItems, ldEvents, desc, genres: [...genresSet], composers };
}

function decideKeep(genres) {
  if (genres.length === 0) return false; // pas de signal → on écarte
  const hasKeep = genres.some((g) => KEEP_GENRES.has(g));
  if (hasKeep) return true;
  // Si toutes les étiquettes sont dans REJECT_GENRES (cas pop pur), on rejette
  const onlyReject = genres.every((g) => REJECT_GENRES.has(g));
  if (onlyReject) return false;
  // Reste : on garde par défaut (Bijloke programme large)
  return true;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function isoDateTime(s) {
  if (!s) return { date: null, time: null };
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return { date: null, time: null };
  return { date: m[1], time: `${m[2]}:${m[3]}` };
}

function buildId(date, url) {
  const slug = (url.match(/\/programma\/([^/?#]+)/) || [])[1] || 'event';
  return `bijloke-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeDeBijloke({
  detailDelay = 350,
  pageDelay = 300,
  pageHardCap = 30,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // 1. Liste paginée
  const allUrls = new Set();
  let page = 1;
  while (page <= pageHardCap) {
    const url = page === 1 ? `${BASE_URL}${LIST_PATH}` : `${BASE_URL}${LIST_PATH}?page=${page}`;
    try {
      console.error(`[bijloke] list page ${page}`);
      const html = await fetchHtml(url);
      const parsed = parseListPage(html);
      const before = allUrls.size;
      parsed.urls.forEach((u) => allUrls.add(u));
      const added = allUrls.size - before;
      if (added === 0 && page > 1) break;
      if (!parsed.nextHref) break;
    } catch (err) {
      console.error(`[bijloke] page ${page} failed: ${err.message}`);
      break;
    }
    page++;
    await sleep(pageDelay);
  }
  console.error(`[bijloke] ${allUrls.size} pages produit distinctes`);

  // 2. Détails + filtrage
  const concerts = [];
  let kept = 0;
  let rejected = 0;
  for (const url of allUrls) {
    try {
      const html = await fetchHtml(url);
      const detail = parseDetailPage(html, composerIndex);
      await sleep(detailDelay);

      if (!decideKeep(detail.genres)) {
        rejected++;
        continue;
      }

      // Une représentation = un item dans dataLayer.detail_items
      let dates = [];
      for (const it of detail.detailItems) {
        const { date, time } = isoDateTime(it.item_date);
        if (!date || date < today) continue;
        const price = typeof it.price === 'number' ? it.price : null;
        dates.push({ date, time, price });
      }
      // Repli sur JSON-LD si dataLayer vide
      if (dates.length === 0) {
        for (const e of detail.ldEvents) {
          const { date, time } = isoDateTime(e.startDate);
          if (!date || date < today) continue;
          dates.push({ date, time, price: null });
        }
      }
      if (dates.length === 0) continue;

      kept++;
      for (const d of dates) {
        concerts.push({
          id: buildId(d.date, url),
          source: 'bijloke',
          venue_id: 'bijloke',
          title: detail.title,
          date: d.date,
          time: d.time,
          url,
          composers: detail.composers,
          performers: [],
          program: detail.desc || null,
          price_min: d.price,
          price_max: d.price,
          scraped_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`[bijloke] detail failed for ${url}: ${err.message}`);
    }
  }

  console.error(`[bijloke] ${kept} productions retenues / ${rejected} rejetées (genres) / ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeDeBijloke()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
