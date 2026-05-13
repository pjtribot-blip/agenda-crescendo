// Scraper Triangel (Centre culturel de la Communauté germanophone, St-Vith)
//
// Phase 2.9 avait essayé www.triangel.be (cassé, redirige Google Sites)
// et www.triangel.cc (NXDOMAIN). Le vrai site est www.triangel.com.
//
// CMS custom .NET (visible aux IDs `C_T_Bottom_M6556_ctl00_rpEvents_ctlN`).
// HTML statique propre. Liste plate sur /evenements/ — pas de pagination,
// tous les événements à venir sont rendus dans la même page (~42 cartes).
//
// Chaque carte (.eventlist__item) :
//   <span class="date">DD mois YYYY</span> - <span class="time">HH:MM</span> h
//   <h2>Title</h2>
//   <h3 class="subtitle">subtitle</h3>
//   <span class="cat">Categorie</span>     // Concert / Musical / Humoriste…
//
// Filtre éditorial strict :
//  - Keep cat exact = "Concert" (rejette les combinés "Concert, Show",
//    "Concert, Performance en direct, Carnaval", etc.)
//  - Sub-filtre titre TITLE_REJECT pour les "Concerts" qui sont en
//    réalité variétés/swing/Volksmusik/rock revival.
//
// En cas de doute, on GARDE (mieux vaut un peu de bruit qu'une absence
// pour ce lieu où le classique est minoritaire — instruction
// utilisateur Phase 3.11).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.triangel.com';
const LIST_PATH = '/evenements/';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  février: 2, août: 8, décembre: 12,
};

// Variétés / Volksmusik / rock revival explicitement non-savant
// même quand le site tagge "Concert".
const TITLE_REJECT_PATTERNS = [
  /^heino\b/i,
  /\boberkrainer\b/i,
  /\bq[-\s]?revival\b/i,
  /jahre musikverein/i,        // harmonie locale folklorique
  /\bglenn miller\b/i,
  /\bbrings\b/i,                // pop rhénan
  /jeck im sunnesching/i,       // carnaval rhénan
  /\btabaluga\b|\bconni\b|\baladin\b/i,  // musicals jeune public (safety net)
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
          'Accept-Language': 'fr-BE,fr;q=0.9,de;q=0.5',
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
    .toLowerCase()
    .trim();
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
// Date / parsing
// ------------------------------------------------------------------
function parseFrDate(s) {
  if (!s) return null;
  const m = s.trim().match(/(\d{1,2})\s+([a-zéûôA-Zéûô]+)\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS_FR[normalize(m[2]).replace(/\.$/, '')];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function parseTime(s) {
  if (!s) return null;
  const m = s.trim().match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.eventlist__item').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;

    // .date contient un sous-<span class="date">DATE</span> et un
    // <span class="time">HH:MM</span> — on prend chaque feuille.
    const $dateOuter = $el.find('span.date').first();
    const dateLeaf = $dateOuter.find('span.date').first().text() || $dateOuter.text();
    const timeLeaf = $el.find('span.time').first().text();
    const date = parseFrDate(dateLeaf);
    const time = parseTime(timeLeaf);
    if (!date) return;

    const title = $el.find('h2').first().text().trim().replace(/\s+/g, ' ');
    const subtitle = $el.find('h3.subtitle').first().text().trim().replace(/\s+/g, ' ');
    const cat = $el.find('span.cat').first().text().trim().replace(/\s+/g, ' ');
    if (!title) return;
    items.push({ url, title, subtitle, date, time, cat });
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
  // URL = /evenements/SLUG/ID/ — on prend slug s'il existe, sinon ID.
  const m = url.match(/\/evenements\/([^/?#]+)\/(\d+)/);
  const part = (m && /[a-z]/i.test(m[1])) ? m[1] : (m ? `e${m[2]}` : 'event');
  const t = time ? `-${time.replace(':', '')}` : '';
  return `triangel-${date}${t}-${part}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeTriangel({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[triangel] list ${url}`);
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
  // Filtre 1 : cat exacte = "Concert" (rejette combinés Show/Performance/Carnaval)
  const concertCat = upcoming.filter((it) => normalize(it.cat) === 'concert');
  // Filtre 2 : titre TITLE_REJECT (variétés / Volksmusik / rock revival)
  const allowed = concertCat.filter((it) => !TITLE_REJECT_PATTERNS.some((re) => re.test(it.title)));
  console.error(`[triangel] ${listed.length} listés / ${upcoming.length} à venir / ${concertCat.length} cat=Concert / ${allowed.length} retenus (reject titre ${concertCat.length - allowed.length})`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers(`${it.title} ${it.subtitle}`, composerIndex);
    const program = it.subtitle ? `${it.cat} — ${it.subtitle}` : it.cat;
    return {
      id: buildId(it.date, it.url, it.time),
      source: 'triangel',
      venue_id: 'triangel',
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: [],
      program: program || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[triangel] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeTriangel()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
