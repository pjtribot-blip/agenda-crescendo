// Scraper Festival Midi-Minimes (Bruxelles)
//
// Édition 2026 (40e édition) — concerts gratuits chaque jour ouvrable,
// été (juillet-août), midis 12h15. Site historique (HTML statique
// classique) sur https://midis-minimes.be (le sous-domaine www. ne
// résout pas).
//
// Structure : la page /fr/Concerts liste tous les concerts du festival
// avec une carte par jour. Chaque carte a un lien
// `fr/Concerts-2026-MM-DD-HH:MM` (date+heure dans le slug d'URL),
// l'ensemble en .cal_ensemble .soliste, le compositeur en
// .programme_month .compositeur et l'œuvre en .oeuvre. Direction
// éventuelle dans .cal_distribution.
//
// Tout est attribué au venue "conservatoire-royal-bruxelles" (le
// festival joue à la Chapelle de la Madeleine + au Conservatoire ;
// on agrège sous l'umbrella CRB pour ne pas multiplier les venues
// internes).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://midis-minimes.be';
const LIST_PATH = '/fr/Concerts';

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

// ------------------------------------------------------------------
// List parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.concert-month').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a[href*="Concerts-"]').first();
    const href = $a.attr('href') || '';
    const m = href.match(/Concerts-(\d{4})-(\d{2})-(\d{2})-(\d{1,2}):(\d{2})/);
    if (!m) return;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    const time = `${m[4].padStart(2,'0')}:${m[5]}`;
    const url = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;

    const ensemble = $el.find('.cal_ensemble .soliste').first().text().trim().replace(/\s+/g, ' ');
    const compositor = $el.find('.programme_month .compositeur').first().text().trim().replace(/\s+/g, ' ');
    const oeuvre = $el.find('.programme_month .oeuvre').first().text().trim().replace(/\s+/g, ' ');
    const distrib = $el.find('.cal_distribution').first().text().trim().replace(/\s+/g, ' ');

    // Titre = compositeur + œuvre si dispo, sinon ensemble
    const title = (compositor && oeuvre) ? `${compositor} — ${oeuvre}` : (ensemble || compositor || '(sans titre)');
    const performers = [ensemble, distrib].filter(Boolean);

    items.push({ url, title, date, time, ensemble, compositor, oeuvre, performers });
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
  const slug = (url.match(/Concerts-([^?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `midi-minimes-${date}${t}-${slug.slice(0, 60)}`.replace(/[^a-zA-Z0-9-]/g, '-').replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeMidiMinimes({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[midi-minimes] list ${url}`);
  const html = await fetchHtml(url);
  let listed = parseListPage(html);

  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  console.error(`[midi-minimes] ${listed.length} listés / ${upcoming.length} à venir`);

  const concerts = upcoming.map((it) => {
    // Compositeurs : on tente le match sur le champ compositor (rare
    // que ça matche du premier coup vu que le format est "Charpentier"
    // ou "Tchaïkovski"). On renvoie le brut s'il n'est pas dans
    // l'index.
    let composers = matchComposers(it.compositor, composerIndex);
    if (composers.length === 0 && it.compositor) composers = [it.compositor];
    return {
      id: buildId(it.date, it.url, it.time),
      source: 'midi-minimes',
      venue_id: 'conservatoire-royal-bruxelles',
      title: it.title,
      date: it.date,
      time: it.time,
      url: it.url,
      composers,
      performers: it.performers,
      program: it.oeuvre || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[midi-minimes] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeMidiMinimes()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
