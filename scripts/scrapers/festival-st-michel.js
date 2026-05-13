// Scraper Festival de l'Abbaye de Saint-Michel-en-Thiérache
//
// 40e édition (2026) : 5 dimanches en juin-juillet, 12 concerts répartis
// en 2-3 programmes par date, dans l'abbatiale et lieux annexes.
//
// La page /programme/ liste les 5 dimanches avec un sommaire thématique
// (ex. 7 juin "Eternelles odyssées"). Chaque date a une page détail :
//   /programme-billetterie/{DD-mois-2026}/
// qui contient les titres des concerts (h2/h3), les programmes
// (compositeurs en h3/h4) et un ou deux horaires (11h30 / 16h30
// typiquement).
//
// Approche : on fetch les 5 pages détail, on extrait les sections
// concert (titre principal + programme). Comme la page n'expose ni
// JSON-LD ni structure stable, on s'appuie sur deux horaires connus
// (11h30 et 16h30 pour les dimanches 2-concerts ; 11h30/15h30/18h
// pour les dates à 3 concerts) et on récupère le programme thématique
// du jour comme titre.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://festival-saint-michel.fr';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Dates 40e édition (2026). Mapping date FR → slug URL + iso date.
const DATES = [
  { slug: '07-juin-2026',    iso: '2026-06-07' },
  { slug: '14-juin-2026',    iso: '2026-06-14' },
  { slug: '21-juin-2026',    iso: '2026-06-21' },
  { slug: '28-juin-2026',    iso: '2026-06-28' },
  { slug: '05-juillet-2026', iso: '2026-07-05' },
];

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
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

// ------------------------------------------------------------------
// Parsing
// ------------------------------------------------------------------
// Le site utilise Elementor : chaque "titre" est un
// <div class="elementor-heading-title">. Les concerts sont précédés
// d'une heure (ex. "11h30"), puis du titre (ex. "L'Orfeo").
// Le bloc "Nous vous proposons également" sépare les concerts des
// déjeuners/rencontres — on coupe la liste à cet ancre.
function parseDayPage(html, isoDate) {
  const $ = cheerio.load(html);
  const headings = [];
  $('.elementor-heading-title').each((_, el) => {
    const t = decodeEntities($(el).text().trim()).replace(/\s+/g, ' ');
    if (t) headings.push(t);
  });
  // Coupe au marqueur de non-concert
  const cutIdx = headings.findIndex((h) => /nous vous proposons|d[eé]jeuner|rencontre.{0,30}artistes/i.test(h));
  const before = cutIdx >= 0 ? headings.slice(0, cutIdx) : headings;

  // Cherche le thème du jour : 1er heading après "DD mois YYYY" et
  // avant le 1er bloc time/title.
  let theme = '';
  for (let i = 0; i < before.length; i++) {
    if (/^\d{1,2}h\d{0,2}$/i.test(before[i])) break;
    if (/^\d{1,2}\s+\w+\s+\d{4}$/i.test(before[i])) continue;
    if (/^\d+\s+concerts?$/i.test(before[i])) continue;
    if (!theme) { theme = before[i]; }
  }

  // Pairs (heure, titre) : pour chaque "Hh[MM]" suivi d'un texte non-heure.
  const concerts = [];
  for (let i = 0; i < before.length - 1; i++) {
    const m = before[i].match(/^(\d{1,2})\s*h\s*(\d{0,2})$/i);
    if (!m) continue;
    const hh = m[1].padStart(2, '0');
    const mm = (m[2] || '00').padStart(2, '0');
    const time = `${hh}:${mm}`;
    // Le titre = prochain heading non-vide qui n'est pas une heure
    let next = '';
    for (let j = i + 1; j < before.length; j++) {
      if (/^\d{1,2}\s*h\s*\d{0,2}$/i.test(before[j])) break;
      if (before[j].length > 2 && before[j].length < 200) { next = before[j]; break; }
    }
    if (next) concerts.push({ time, title: next });
  }

  return { isoDate, theme, concerts };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, slug, time, idx) {
  const t = time ? `-${time.replace(':', '')}` : '';
  const i = idx ? `-${idx}` : '';
  return `st-michel-${date}${t}${i}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeStMichel({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const concerts = [];
  for (const { slug, iso } of DATES) {
    if (iso < today) continue;
    const url = `${BASE_URL}/programme-billetterie/${slug}/`;
    console.error(`[st-michel] ${url}`);
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.error(`[st-michel]   failed: ${err.message}`);
      continue;
    }
    const parsed = parseDayPage(html, iso);
    if (!parsed.concerts.length) {
      console.error(`[st-michel]   aucun concert détecté pour ${iso}`);
      continue;
    }
    // Elementor rend deux versions (desktop+mobile) de chaque heading,
    // ce qui duplique chaque (time, title). Dédupe.
    const seenKey = new Set();
    parsed.concerts = parsed.concerts.filter((c) => {
      const k = `${c.time}|${normalize(c.title).slice(0, 50)}`;
      if (seenKey.has(k)) return false;
      seenKey.add(k);
      return true;
    });
    parsed.concerts.forEach((c, idx) => {
      const composers = matchComposers(`${c.title} ${parsed.theme}`, composerIndex);
      concerts.push({
        id: buildId(iso, slug, c.time, idx + 1),
        source: 'st-michel',
        venue_id: 'abbaye-saint-michel-thierache',
        title: `${parsed.theme ? parsed.theme + ' — ' : ''}${c.title}`.slice(0, 200),
        date: iso,
        time: c.time,
        url,
        composers,
        performers: [],
        program: parsed.theme || null,
        price_min: null,
        price_max: null,
        scraped_at: new Date().toISOString(),
      });
    });
    await sleep(300);
  }

  console.error(`[st-michel] ${concerts.length} concerts produits sur ${DATES.length} dates`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeStMichel()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
