// Scraper Concerts du Printemps de Val-Dieu (Aubel, Belgique)
//
// Festival annuel de musique de chambre en mai-juin, programmation
// 100% classique. Concerts tous les vendredis à 20h à l'Abbaye de
// Val-Dieu (Basilique). 58e édition en 2026 (22 mai → 19 juin).
//
// Site WordPress + thème Avia (Enfold). HTML statique propre :
// la page /programme/ embarque le calendrier dans une section
// `calendrier-concerts` avec un <h3> par concert au format :
//   "DD-MM-YYYY – Artiste, instrument, HHh"
// (ou variantes "ORCW s.l.d. Robert Ortman, 20h", "Ensemble
// L'Arpeggiata – Christina Pluhar – Céline Scheen, 20h").
//
// Tout l'agenda du festival a lieu à un seul venue physique
// (abbaye-val-dieu, créé pour cette source). Filtre éditorial :
// AUCUN (la programmation est 100% classique/musique de chambre).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://concertsduprintemps.be';
const LIST_PATH = '/programme/';

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
// Parsing — section calendrier-concerts
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  // Pattern "DD-MM-YYYY – ARTISTE, ..., HHh"
  // On parcourt tous les h3 et on retient ceux qui matchent.
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const t = decodeEntities($(el).text().trim()).replace(/\s+/g, ' ');
    // Date format DD-MM-YYYY
    const m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s*[–\-—]\s*(.+?)\s*,\s*(\d{1,2})h(\d{0,2})?$/);
    if (!m) return;
    const [, DD, MM, YYYY, label, hh, mm] = m;
    const date = `${YYYY}-${MM.padStart(2,'0')}-${DD.padStart(2,'0')}`;
    const time = `${hh.padStart(2,'0')}:${(mm || '00').padStart(2,'0')}`;
    items.push({ date, time, label });
  });
  return items;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, label, time) {
  const slug = normalize(label).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const t = time ? `-${time.replace(':', '')}` : '';
  return `valdieu-${date}${t}-${slug || 'concert'}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeValDieu({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[valdieu] list ${url}`);
  const html = await fetchHtml(url);
  let listed = parseListPage(html);

  // Dédupe (date, time, label)
  const seen = new Set();
  listed = listed.filter((it) => {
    const k = `${it.date}|${it.time}|${normalize(it.label).slice(0, 60)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  console.error(`[valdieu] ${listed.length} listés / ${upcoming.length} à venir`);

  const concerts = upcoming.map((it) => {
    const composers = matchComposers(it.label, composerIndex);
    return {
      id: buildId(it.date, it.label, it.time),
      source: 'valdieu',
      venue_id: 'abbaye-val-dieu',
      title: it.label,
      date: it.date,
      time: it.time,
      url,
      composers,
      performers: [it.label],
      program: 'Concerts du Printemps de Val-Dieu — Abbaye de Val-Dieu (Aubel)',
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[valdieu] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeValDieu()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
