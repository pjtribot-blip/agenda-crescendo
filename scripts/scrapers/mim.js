// Scraper MIM — Musée des Instruments de Musique (Bruxelles)
//
// L'agenda /fr/agenda-1 est paginé (?page=N). Chaque entrée est un
// <article class="m-article-excerpt"> wrappé dans un <a href="/fr/activity/SLUG">.
// Une .a-card interne porte la date (figure span "DD.MM.YYYY"), le titre
// (<h4>) et un sous-titre (<blockquote>) qui mentionne souvent
// l'organisateur (Conservatoire royal, Koninklijk Conservatorium, MIM,
// "Voyage Musical", "Broodje Brussel"…).
//
// Filtre éditorial : la programmation est de tradition savante (concerts
// de midi, récitals, étudiants conservatoires, musique ancienne). On
// rejette les visites guidées, ateliers, conférences via les motifs de
// titre.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.mim.be';
const LIST_PATH = '/fr/agenda-1';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const TITLE_REJECT_PATTERNS = [
  /^visite/i,
  /^atelier/i,
  /^conf[eé]rence/i,
  /^journ[eé]e\s+du/i,
  /^journ[eé]e\s+portes/i,
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
// List parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('article.m-article-excerpt').each((_, el) => {
    const $el = $(el);
    const href = $el.find('a.a-card').first().attr('href')
      || $el.find('a[href*="/fr/activity/"]').first().attr('href')
      || '';
    if (!href || !/\/fr\/activity\//.test(href)) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;

    const dateText = $el.find('figure span').first().text().trim();
    const dm = dateText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!dm) return;
    const date = `${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`;

    const title = $el.find('h4').first().text().trim().replace(/\s+/g, ' ');
    const subtitle = $el.find('blockquote').first().text().trim().replace(/\s+/g, ' ');
    if (!title) return;
    items.push({ url, title, subtitle, date });
  });
  // Pagination
  const pages = new Set();
  $('a[href*="?page="]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/page=(\d+)/);
    if (m) pages.add(parseInt(m[1], 10));
  });
  const maxPage = pages.size ? Math.max(...pages) : 0;
  return { items, maxPage };
}

function isAllowed(item) {
  return !TITLE_REJECT_PATTERNS.some((re) => re.test(item.title));
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/activity\/([^/?#]+)/) || [])[1] || 'event';
  return `mim-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeMIM({
  pageDelay = 250,
  pageHardCap = 10,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  console.error(`[mim] list page 0`);
  const firstHtml = await fetchHtml(`${BASE_URL}${LIST_PATH}`);
  const first = parseListPage(firstHtml);
  let listed = [...first.items];
  const last = Math.min(first.maxPage, pageHardCap);
  for (let p = 1; p <= last; p++) {
    console.error(`[mim] list page ${p}`);
    try {
      const html = await fetchHtml(`${BASE_URL}${LIST_PATH}?page=${p}`);
      const parsed = parseListPage(html);
      listed.push(...parsed.items);
    } catch (err) {
      console.error(`[mim] page ${p} failed: ${err.message}`);
    }
    await sleep(pageDelay);
  }

  // Dédupe (url, date)
  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  const allowed = upcoming.filter(isAllowed);
  console.error(`[mim] ${listed.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus (rejet ${upcoming.length - allowed.length} visites/ateliers/conférences)`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers([it.title, it.subtitle].filter(Boolean).join(' '), composerIndex);
    return {
      id: buildId(it.date, it.url),
      source: 'mim',
      venue_id: 'mim',
      title: it.title,
      date: it.date,
      time: null,
      url: it.url,
      composers,
      performers: [],
      program: it.subtitle || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[mim] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeMIM()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
