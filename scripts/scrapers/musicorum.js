// Scraper Festival Musicorum (Auditorium MRBAB, Bruxelles)
//
// WordPress + plugin "The Events Calendar" (tribe-events). La page
// /events/YYYY-MM/ liste tous les événements du mois, un par <article>
// avec :
//   <time datetime="YYYY-MM-DD">…</time>  (la date)
//   <time datetime="HH:MM">…</time>       (start)
//   <time datetime="HH:MM">…</time>       (end)
//   <a href="/event/SLUG/" title="Titre">…</a>
//
// Édition 2026 : 1er juillet → 28 août, midis 12h15-13h, gratuit, à
// l'Auditorium 490 Philippe Roberts-Jones (MRBAB). On scrape les deux
// mois, attribue tout au venue "mrbab-auditorium" et le tag
// musicorum-2026 est appliqué automatiquement via festivals.json.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.musicorum.be';

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
  $('article').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a[href*="/event/"]').first();
    const href = $a.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    const title = ($a.attr('title') || $a.text() || '').trim().replace(/\s+/g, ' ');
    if (!title) return;

    // Trouve la date complète (datetime YYYY-MM-DD) et l'heure de début
    let date = null;
    let time = null;
    $el.find('time[datetime]').each((_, t) => {
      const dt = $(t).attr('datetime') || '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(dt) && !date) date = dt;
      else if (/^\d{2}:\d{2}$/.test(dt) && !time) time = dt;
    });
    if (!date) return;

    // Description sommaire (premier paragraphe ou excerpt)
    const desc = $el.find('.tribe-events-calendar-list__event-description, .tribe-events-c-small-cta__text').first()
      .text().replace(/\s+/g, ' ').trim();

    items.push({ url, title, date, time, desc });
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
  const slug = (url.match(/\/event\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `musicorum-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

function monthsRange() {
  // Édition 2026 publiée : juillet + août.
  // On boucle largement (juin → septembre) pour anticiper les éditions
  // futures et les mois adjacents.
  return ['2026-06', '2026-07', '2026-08', '2026-09'];
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeMusicorum({
  monthDelay = 250,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  let listed = [];
  for (const m of monthsRange()) {
    const url = `${BASE_URL}/events/${m}/`;
    try {
      console.error(`[musicorum] list ${m}`);
      const html = await fetchHtml(url);
      listed.push(...parseListPage(html));
    } catch (err) {
      console.error(`[musicorum] ${m} failed: ${err.message}`);
    }
    await sleep(monthDelay);
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
  console.error(`[musicorum] ${listed.length} listés / ${upcoming.length} à venir`);

  const concerts = upcoming.map((it) => ({
    id: buildId(it.date, it.url, it.time),
    source: 'musicorum',
    venue_id: 'mrbab-auditorium',
    title: it.title,
    date: it.date,
    time: it.time,
    url: it.url,
    composers: matchComposers(it.title + ' ' + (it.desc || ''), composerIndex),
    performers: [],
    program: it.desc || null,
    price_min: 0,
    price_max: 0,
    scraped_at: new Date().toISOString(),
  }));

  console.error(`[musicorum] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeMusicorum()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
