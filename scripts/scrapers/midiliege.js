// Scraper Concerts de Midi Liège (Société Royale ASBL)
//
// Concerts traditionnels du mardi à 12h30 à la Salle Académique de
// l'ULiège (Place du XX Août 7, 4000 Liège). Saison sept-juin.
//
// État au 12 mai 2026 : la page /programme/ ne contient encore aucun
// concert publié — la saison 2025-2026 est terminée et la saison
// 2026-2027 n'a pas encore été annoncée (publication typiquement
// juin-août).
//
// Le scraper est donc opérationnel mais retourne actuellement 0
// concerts. Il se réveillera automatiquement à la publication de
// la saison 2026-2027.
//
// Stratégie de parsing (à confirmer quand la programmation
// sera disponible) :
//  - Fetch /programme/ (HTML statique WordPress, pas de plugin
//    Tribe Events détecté ni d'API REST exploitable)
//  - Chercher des cartes/articles avec :
//      * Date au format "DD mois YYYY" ou similaire
//      * Titre dans h2/h3/h4
//      * Lien vers fiche détail (si existe)
//  - Heure par défaut : 12:30 (jour traditionnel mardi midi)
//  - Filtre : tout passe (programmation 100% classique)

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.midiliege.be';
const LIST_PATH = '/programme/';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  février: 2, août: 8, décembre: 12,
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
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
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
// List parsing — heuristique tolérante car le markup réel n'est pas
// connu (page vide au moment de l'écriture du scraper).
// ------------------------------------------------------------------
function parseFrDate(s) {
  if (!s) return null;
  const m = s.trim().match(/(\d{1,2})\s+([a-zéûô]+)\s+(\d{4})/i);
  if (!m) return null;
  const month = MONTHS_FR[normalize(m[2]).replace(/\.$/, '')];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  // Stratégie 1 : articles classiques WordPress
  $('article, .event, .concert, .programme-item, .post').each((_, el) => {
    const $el = $(el);
    const title = $el.find('h1, h2, h3, h4').first().text().trim().replace(/\s+/g, ' ');
    if (!title) return;
    const text = $el.text().replace(/\s+/g, ' ');
    const date = parseFrDate(text);
    if (!date) return;
    const $a = $el.find('a[href]').first();
    const href = $a.attr('href') || '';
    const url = href.startsWith('http') ? href : (href ? BASE_URL + (href.startsWith('/') ? href : '/' + href) : `${BASE_URL}${LIST_PATH}`);
    const tMatch = text.match(/(\d{1,2})\s*[hH:](\d{2})/);
    const time = tMatch ? `${tMatch[1].padStart(2,'0')}:${tMatch[2]}` : '12:30';
    items.push({ url, title, date, time });
  });

  return items;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, title, time) {
  const slug = normalize(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const t = time ? `-${time.replace(':', '')}` : '';
  return `midiliege-${date}${t}-${slug || 'event'}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeMidiLiege({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[midiliege] list ${url}`);
  let html;
  try { html = await fetchHtml(url); }
  catch (err) {
    console.error(`[midiliege]   échec : ${err.message}`);
    return [];
  }

  let listed = parseListPage(html);

  // Dédupe (date, time, normalize-title)
  const seen = new Set();
  listed = listed.filter((it) => {
    const k = `${it.date}|${it.time}|${normalize(it.title).slice(0, 60)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  console.error(`[midiliege] ${listed.length} listés / ${upcoming.length} à venir`);

  const concerts = upcoming.map((it) => {
    const composers = matchComposers(it.title, composerIndex);
    return {
      id: buildId(it.date, it.title, it.time),
      source: 'midiliege',
      venue_id: 'midiliege',
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: [],
      program: null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[midiliege] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeMidiLiege()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
