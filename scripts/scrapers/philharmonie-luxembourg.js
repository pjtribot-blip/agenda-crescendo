// Scraper Philharmonie Luxembourg
//
// Stratégie :
//  1. Liste : on itère /fr/programme?month=M&page=N. Le site renvoie 16
//     événements par page, paginés par mois courant. On boucle sur les
//     pages tant qu'on a des événements ; un mois à 0 événements arrête
//     le scrape.
//  2. Filtre éditorial : la Philharmonie est ouverte (musique du monde,
//     jazz, kids…). On rejette par tag : "0–2 ans", "4–8 ans" et tout
//     autre tag jeune public via la classe `kids=true`. On garde tout le
//     reste — y compris jazz / world — car la programmation y est
//     éditorialement curatée et de tradition souvent savante. Si du
//     bruit apparaît, on filtrera par titre comme pour Grand Manège.
//  3. Pas de page détail nécessaire : la liste expose URL, titre,
//     sous-titre, date+heure, salle, et tags.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.philharmonie.lu';
const LIST_PATH = '/fr/programme';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Tags qui suffisent à rejeter (jeune public)
const REJECT_TAGS = new Set([
  '0–2 ans', '0-2 ans',
  '4–8 ans', '4-8 ans',
  '6–10 ans', '6-10 ans',
  '8–12 ans', '8-12 ans',
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
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
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
// Date parsing
// ------------------------------------------------------------------
// "10/05/2026 00:00:00" → "2026-05-10"
function parseDateAttr(s) {
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// ------------------------------------------------------------------
// List page parsing
// ------------------------------------------------------------------
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('li.c-event-list-item').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a.event-list-item__date').first();
    const dateAttr = $a.find('time').first().attr('datetime') || '';
    const date = parseDateAttr(dateAttr);

    let time = null;
    const $time = $el.find('span.event-list-item__date-time').first();
    if ($time.length) {
      const t = $time.text().trim();
      const tm = t.match(/(\d{1,2}):(\d{2})/);
      if (tm) time = `${tm[1].padStart(2, '0')}:${tm[2]}`;
    }

    const $aContent = $el.find('a.event-list-item__content').first();
    const href = $aContent.attr('href') || $a.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    const title = $aContent.find('h5').first().text().trim().replace(/\s+/g, ' ');
    const subtitle = $aContent.find('.event-list-item__subtitle').first().text().trim().replace(/\s+/g, ' ');
    const room = $aContent.find('.event-list-item__label').first().text().trim().replace(/\s+/g, ' ');

    // Tags : extraits depuis les @click="$dispatch('addtagnotify', { value: '…', label: '…' })"
    const tags = [];
    $el.find('button[\\@click*="addtagnotify"]').each((_, btn) => {
      const onClick = $(btn).attr('@click') || '';
      const m = onClick.match(/value:\s*'([^']+)'/);
      if (m) tags.push(decodeEntities(m[1]).trim());
    });

    if (!date || !title) return;
    items.push({ url, title, subtitle, date, time, room, tags });
  });

  return items;
}

function isAllowed(item) {
  if (item.tags.some((t) => REJECT_TAGS.has(t))) return false;
  return true;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/programme\/[^/]+\/([^/?#]+)/) || [])[1] || 'event';
  return `phillux-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapePhilLuxembourg({
  pageDelay = 250,
  maxPagesPerMonth = 50,
  monthsAhead = 14,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();
  const todayDate = new Date();

  let listed = [];
  // Itère mois courant à +monthsAhead
  for (let i = 0; i <= monthsAhead; i++) {
    const d = new Date(todayDate.getFullYear(), todayDate.getMonth() + i, 1);
    const month = d.getMonth() + 1;
    let page = 1;
    let consecutiveEmpty = 0;
    while (page <= maxPagesPerMonth) {
      const url = page === 1
        ? `${BASE_URL}${LIST_PATH}?month=${month}`
        : `${BASE_URL}${LIST_PATH}?page=${page}&month=${month}`;
      try {
        const html = await fetchHtml(url);
        const items = parseListPage(html);
        if (items.length === 0) break;
        const before = listed.length;
        listed.push(...items);
        const added = listed.length - before;
        if (added === 0) consecutiveEmpty++; else consecutiveEmpty = 0;
        if (consecutiveEmpty >= 2) break;
      } catch (err) {
        console.error(`[phillux] page ${page} month=${month} failed: ${err.message}`);
        break;
      }
      page++;
      await sleep(pageDelay);
    }
    console.error(`[phillux] month=${month} (offset +${i}) → cumul ${listed.length}`);
  }

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
  console.error(`[phillux] ${listed.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers([it.title, it.subtitle].filter(Boolean).join(' '), composerIndex);
    return {
      id: buildId(it.date, it.url),
      source: 'phillux',
      venue_id: 'philharmonielux',
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: [],
      program: it.subtitle || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[phillux] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapePhilLuxembourg()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
