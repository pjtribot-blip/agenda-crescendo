// Scraper Cité musicale Metz (Arsenal + Saint-Pierre-aux-Nonnains)
//
// La Cité musicale-Metz regroupe 4 lieux : Arsenal (salle de concerts
// majeure, résidence Orchestre national de Lorraine), Saint-Pierre-aux-
// Nonnains (chapelle baroque), BAM (musiques actuelles, hors périmètre)
// et Trinitaires (musiques actuelles, hors périmètre).
//
// On scrape /programmation paginé (Nuxt SSR — la liste est rendue
// dans le HTML). Pour chaque carte :
//   <time datetime="2026-05-21T18:30">21 mai 2026, 20h30</time>
//   <p class="place_*">Trinitaires</p>
//   <h3 ...><a href="/fr/programmation/...">Title</a></h3>
//   <p class="over-title_*">Concert</p>   (catégorie : Concert / Spectacle…)
//
// Filtre : on garde Arsenal + Saint-Pierre-aux-Nonnains uniquement.
// Sous-filtre titre : la programmation Arsenal mêle classique + jazz
// acoustique + world. On rejette uniquement les motifs clairement
// hors-périmètre (pop électro déguisée en concert).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://citemusicale-metz.fr';
const LIST_PATH = '/programmation';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Lieux retenus (texte tel qu'affiché dans <p class="place_*">)
const KEEP_VENUES = /^(?:Arsenal|Saint-Pierre-aux-Nonnains)$/i;

// Hard reject patterns (world/pop électro). À étendre si bruit.
const TITLE_REJECT = [
  /\btropical fuck storm\b/i,
];

// Catégories à rejeter (over-title). On veut Concert / Spectacle musical /
// Récital ; pas d'expositions ni d'ateliers.
const CATEGORY_REJECT = /^(?:Exposition|Atelier|Visite|Rencontre)$/i;

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

// ------------------------------------------------------------------
// Page parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  // Chaque carte = <a href="/fr/programmation/saison-..."> imbriqué
  // dans un wrapper contenant <h3> title, <time>, <p class*="place_">.
  // Le wrapper n'a pas de classe stable ; on parcourt les <time>.
  $('time[datetime]').each((_, t) => {
    const $t = $(t);
    const datetime = $t.attr('datetime') || '';
    const m = datetime.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!m) return;
    const date = m[1];
    const time = m[2] && m[3] ? `${m[2]}:${m[3]}` : null;

    // Wrapper card : on remonte au plus proche div.card-like.
    // Heuristique : closest('div[class*="card_"]') ou closest('.root_')
    let $card = $t.closest('div[class*="card_"]');
    if (!$card.length) $card = $t.closest('div').parent();
    if (!$card.length) return;

    const place = $card.find('p[class*="place_"]').first().text().trim();
    const $a = $card.find('h3 a[href*="/programmation/"]').first();
    const href = $a.attr('href') || '';
    const title = $a.text().trim().replace(/\s+/g, ' ');
    const cat = $card.find('p[class*="over-title_"]').first().text().trim().replace(/\s+/g, ' ');
    if (!href || !title) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    items.push({ url, title, date, time, place, cat });
  });

  return items;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url, time) {
  const slug = (url.match(/\/programmation\/[^/]+\/([^/]+)\/([^/?#]+)/) || [])[2]
    || (url.match(/\/([^/]+)$/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `arsenal-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeArsenalMetz({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const allItems = [];
  for (let page = 1; page <= 6; page++) {
    const url = `${BASE_URL}${LIST_PATH}?page=${page}`;
    console.error(`[arsenal-metz] page ${page} ${url}`);
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.error(`[arsenal-metz]   page ${page} failed: ${err.message}`);
      break;
    }
    const items = parseListPage(html);
    if (!items.length) break;
    allItems.push(...items);
  }

  // Dédupe (url, date)
  const seen = new Set();
  const unique = allItems.filter((it) => {
    const k = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const upcoming = unique.filter((it) => it.date >= today);
  const venueFiltered = upcoming.filter((it) => KEEP_VENUES.test(it.place));
  const noExpo = venueFiltered.filter((it) => !CATEGORY_REJECT.test(it.cat || ''));
  const allowed = noExpo.filter((it) => !TITLE_REJECT.some((re) => re.test(it.title)));
  console.error(`[arsenal-metz] ${unique.length} cartes / ${upcoming.length} à venir / ${venueFiltered.length} Arsenal+St-Pierre / ${noExpo.length} hors expo/atelier / ${allowed.length} retenus`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers(it.title, composerIndex);
    return {
      id: buildId(it.date, it.url, it.time),
      source: 'arsenal-metz',
      venue_id: 'arsenal-metz',
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: [],
      program: [it.cat, it.place].filter(Boolean).join(' — ') || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[arsenal-metz] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeArsenalMetz()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
