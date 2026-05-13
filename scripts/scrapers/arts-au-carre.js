// Scraper Arts au Carré (ARTS² — École supérieure des arts, Mons)
//
// Programme public de l'ARTS² (Conservatoire royal de Mons, rue de
// Nimy 7) sur https://www.artsaucarre.be — section /events/
// catégorisée par discipline (musique, théâtre, danse, arts visuels).
//
// Stratégie : la page /events/categories/musique-fr/ embarque dans
// son <ul> "Upcoming Events" toutes les fiches musique du mois à
// venir au format :
//   <li><a href="URL">TITLE</a> - DD/MM/YYYY - HH h MM min - HH h MM min</li>
// (ou avec date_start - date_end avant les heures pour les
// événements multi-jours)
// On dispose donc des dates+heures sans avoir besoin de fetch des
// détails. Pas de description riche disponible : on garde le titre
// + range horaire en program.
//
// Filtre éditorial :
//  - GARDER : préfixes "CONCERT²", "LES MIDIS D'ARTS²", "RÉCITAL²",
//    "Festival Studio" (concerts publics gratuits du Pôle hainuyer
//    + classes ouvertes au public)
//  - REJET : "ÉVALUATION²" (évaluations internes étudiants, non
//    publiques), "AUDITION²" internes, "MASTERCLASS" fermées
//
// On utilise venue_id "arts2" (existant) plutôt qu'un nouveau venue
// car Arts au Carré et ARTS² sont la même salle physique
// (Auditorium d'ARTS², rue de Nimy 7).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.artsaucarre.be';
const LIST_PATH = '/events/categories/musique-fr/';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const TITLE_REJECT_PATTERNS = [
  /^[ÉE]VALUATION/i,
  /^AUDITION/i,
  /\bmasterclass\b/i,
  /\bcours public\b/i,
  /\bjury\b/i,
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

// ------------------------------------------------------------------
// List parsing
// ------------------------------------------------------------------
// "07/05/2026 - 13/05/2026 - 8 h 30 min - 18 h 00 min" → first date+time
// "12/05/2026 - 11 h 15 min - 12 h 30 min" → single date + 1 time
function parseLine(text) {
  // Récupère toutes les dates DD/MM/YYYY
  const dates = [...text.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
  if (!dates.length) return null;
  const d1 = dates[0];
  const date = `${d1[3]}-${d1[2].padStart(2, '0')}-${d1[1].padStart(2, '0')}`;
  // Récupère la première heure (HH h MM min)
  const tMatch = text.match(/(\d{1,2})\s*h\s*(\d{0,2})\s*min/);
  let time = null;
  if (tMatch) {
    const hh = tMatch[1].padStart(2, '0');
    const mm = (tMatch[2] || '00').padStart(2, '0');
    time = `${hh}:${mm}`;
  }
  return { date, time };
}

function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  // Le bloc "Upcoming Events" est un <ul> qui suit un <h3> du même nom.
  // On parcourt tous les <li> contenant un <a href="/events/SLUG/">.
  $('li').each((_, li) => {
    const $li = $(li);
    const $a = $li.find('a[href^="https://www.artsaucarre.be/events/"], a[href^="/events/"]').first();
    const href = $a.attr('href') || '';
    if (!href || /\/events\/(?:categories|page)\b/.test(href)) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    const title = $a.text().trim().replace(/\s+/g, ' ');
    if (!title) return;
    // Le texte de <li> contient l'ancre + " - DATE - HEURE_START - HEURE_END"
    const full = $li.text().trim().replace(/\s+/g, ' ');
    const parsed = parseLine(full);
    if (!parsed) return;
    items.push({ url, title, date: parsed.date, time: parsed.time, rawLine: full });
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
  const slug = (url.match(/\/events\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `arts-au-carre-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeArtsAuCarre({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[arts-au-carre] list ${url}`);
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
  const allowed = upcoming.filter((it) => !TITLE_REJECT_PATTERNS.some((re) => re.test(it.title)));
  const skipped = upcoming.length - allowed.length;
  console.error(`[arts-au-carre] ${listed.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus (skip évaluations/auditions/jurys ${skipped})`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers(it.title, composerIndex);
    // Le program affiche le titre original + range horaire (parseLine
    // ne renvoie que start ; le rawLine contient start + end)
    const program = it.rawLine.replace(/^.*?-\s*/, '').slice(0, 200);
    return {
      id: buildId(it.date, it.url, it.time),
      source: 'arts-au-carre',
      venue_id: 'arts2',
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

  console.error(`[arts-au-carre] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeArtsAuCarre()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
