// Scraper Conservatoire royal de Bruxelles (CRB)
//
// La page /evenements/concerts-spectacles/ liste les concerts publics
// à venir. Chaque carte porte :
//   .category coloredBg     → genre tag (Jazz, Musique classique et
//                              contemporaine, Musique ancienne, etc.)
//   <h3>                     → titre du concert
//   .details span × 3        → 1° venue local, 2° "DD mois YYYY HH:MM",
//                              3° info billetterie (gratuit, etc.)
//
// Stratégie :
//  - Pas de filtre genre : tout passe (le CRB programme principalement
//    classique + jazz savant).
//  - Dédoublonnage avec mim.js : si la venue contient "MIM", on skip
//    (mim.js scrape déjà ces concerts de midi du mardi).
//  - Le scraper attribue toujours venue_id "conservatoire-royal-bruxelles"
//    car le CRB est l'organisateur, même quand le concert se tient
//    ailleurs (Maison d'Érasme, Auditorium Seventy-Eight, Parlement,
//    Le Baixu…). Ces lieux ne sont pas dans nos venues : on les met
//    en program text pour info.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.conservatoire.be';
const LIST_PATH = '/evenements/concerts-spectacles/';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  janv: 1, fev: 2, févr: 2, avr: 4, juill: 7, aou: 8, sept: 9, sep: 9,
  oct: 10, nov: 11, dec: 12, déc: 12,
};

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
// Date parsing — "19 mai 2026 12:30"
// ------------------------------------------------------------------
function parseFrenchDateTime(s) {
  if (!s) return { date: null, time: null };
  const m = s.match(/(\d{1,2})\s+([a-zéûô.]+)\s+(\d{4})(?:\s+(\d{1,2})[:hH](\d{2}))?/i);
  if (!m) return { date: null, time: null };
  const day = parseInt(m[1], 10);
  const month = MONTHS_FR[normalize(m[2]).replace(/\.$/, '')];
  const year = parseInt(m[3], 10);
  if (!month) return { date: null, time: null };
  const time = (m[4] && m[5]) ? `${m[4].padStart(2,'0')}:${m[5]}` : null;
  return {
    date: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
    time,
  };
}

// ------------------------------------------------------------------
// List parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  // Chaque carte : div.content avec .category, h3, .details span × N
  $('a[href*="/evenements/"]').each((_, a) => {
    const $a = $(a);
    const card = $a.closest('.content');
    if (!card.length) return;
    const title = card.find('h3').first().text().trim().replace(/\s+/g, ' ');
    if (!title) return;
    const cat = card.find('.category').first().text().trim();
    const details = card.find('.details span').toArray().map((s) => $(s).text().trim());
    const venueLocal = details[0] || '';
    const dateText = details[1] || '';
    const { date, time } = parseFrenchDateTime(dateText);
    if (!date) return;
    const href = $a.attr('href') || '';
    const url = href.startsWith('http') ? href : BASE_URL + href;
    items.push({ url, title, cat, venueLocal, date, time });
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
  const slug = (url.match(/\/evenements\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `crb-${date}${t}-${slug}`.replace(/--+/g, '-').replace(/\.html$/, '').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeCRB({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[crb] list ${url}`);
  const html = await fetchHtml(url);
  let listed = parseListPage(html);

  // Dédupe (url, date, time)
  const seen = new Set();
  listed = listed.filter((it) => {
    const k = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  // Dédoublonnage venues déjà scrapées par d'autres sources :
  //  - MIM (mim.js scrape les Concerts de Midi du mardi)
  //  - KBR / Bibliothèque royale (kbr.js scrape l'Auditorium Mont des Arts)
  const allowed = upcoming.filter((it) => {
    const v = it.venueLocal || '';
    if (/^MIM\b|Mus[eé]e des Instruments de Musique/i.test(v)) return false;
    if (/\bKBR\b|Biblioth[eè]que royale/i.test(v)) return false;
    return true;
  });
  const skipped = upcoming.length - allowed.length;
  console.error(`[crb] ${listed.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus (skip MIM/KBR ${skipped})`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers(it.title, composerIndex);
    return {
      id: buildId(it.date, it.url, it.time),
      source: 'crb',
      venue_id: 'conservatoire-royal-bruxelles',
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: [],
      // On affiche le lieu local en program pour ne pas perdre l'info
      // (Maison d'Érasme, Auditorium Seventy-Eight, Parlement…)
      program: it.venueLocal ? `${it.cat || 'Concert'} — ${it.venueLocal}` : (it.cat || null),
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[crb] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeCRB()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
