// Scraper MA Festival Brugge — édition 2026 (31 juillet → 9 août)
//
// Site WebFlow custom. La page /programma liste les productions, chaque
// fiche /programma/SLUG contient le concert principal en haut, suivi
// éventuellement de concerts liés/recommandés.
//
// Stratégie hybride :
//  - On extrait le PREMIER bloc daté (.tag-item avec date+heure) de la
//    fiche, qui correspond au concert décrit par la page.
//  - Le venue (texte .text-size-small juste après) est inspecté :
//      • s'il contient "Concertgebouw Brugge" → on SKIP (cgbrugge.js
//        scrape déjà ces concerts ; le tag ma-festival-2026 sera
//        appliqué automatiquement via festivals.json).
//      • sinon → venue_id "ma-festival" (parapluie pour les églises et
//        autres lieux brugeois hors-circuit).
//  - On filtre les compétitions (digitale eerste ronde, halve finale,
//    Davidsfonds Academie cours…) — non éditoriales.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

// Site officiel NL/EN uniquement (pas de /fr/). On scrape la version
// EN — plus accessible aux lecteurs francophones que le NL, et
// pertinente pour un festival international de musique ancienne.
const BASE_URL = 'https://www.mafestival.be';
const LIST_PATH = '/en/programma';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Patterns en NL et EN — on scrape la version EN mais on garde
// les variantes NL au cas où le site change.
const TITLE_REJECT_PATTERNS = [
  /digitale?\s+(eerste\s+ronde|ronde|first\s+round)/i,
  /\b(halve\s+finale|semi[-\s]?final)\b/i,
  /davidsfonds\s+academie/i,
  /^masterclass/i,
  /\bMA\s+Competition\b/i,
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
          'Accept-Language': 'en;q=0.9,fr;q=0.8,nl;q=0.7',
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
function parseListUrls(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $('a[href^="/en/programma/"], a[href^="/programma/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (/^\/(?:en\/)?programma\/?$/.test(href)) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    urls.add(url.replace(/\/$/, ''));
  });
  return [...urls];
}

// ------------------------------------------------------------------
// Detail parsing — extract first dated concert
// ------------------------------------------------------------------
function parseDetailFirst(html, composerIndex) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim().replace(/\s+/g, ' ');

  // Cherche le premier .tag-item contenant une date DD.MM.YYYY
  let date = null, time = null, venue = null, programText = '';
  const re = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;
  $('.tag-item').each((_, el) => {
    if (date) return; // déjà trouvé
    const txt = $(el).text();
    const m = txt.match(re);
    if (!m) return;
    date = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    // L'heure suit immédiatement la date (sinon on capture des nombres
    // sans rapport, type ID CSS qui ressemble à HH:MM).
    const tail = txt.slice(txt.indexOf(m[0]) + m[0].length);
    const tm = tail.match(/^\D{0,40}(\d{1,2}):(\d{2})/);
    if (tm) {
      const h = parseInt(tm[1], 10);
      if (h >= 0 && h <= 23) time = `${tm[1].padStart(2,'0')}:${tm[2]}`;
    }

    // Venue : on cherche le prochain .text-size-small dans le DOM
    const next = $(el).closest('div').nextAll('.text-size-small').first();
    if (next.length) venue = next.text().trim().replace(/\s+/g, ' ');
    // Sinon on remonte un peu et on cherche le prochain
    if (!venue) {
      const wrap = $(el).closest('[class*="container"], [class*="row"], section, article').first();
      const v = wrap.find('.text-size-small').first();
      if (v.length) venue = v.text().trim().replace(/\s+/g, ' ');
    }
  });

  // Programme + description
  programText = $('.text-rich-text').first().text().replace(/\s+/g, ' ').trim();
  const composers = matchComposers([title, programText.slice(0, 1500)].join(' '), composerIndex);

  return { title, date, time, venue, program: programText.slice(0, 400), composers };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function buildId(date, url, time) {
  const slug = (url.match(/\/(?:en\/)?programma\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `mafest-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeMAFestival({
  detailDelay = 350,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const listUrl = `${BASE_URL}${LIST_PATH}`;
  console.error(`[ma-festival] list ${listUrl}`);
  const listHtml = await fetchHtml(listUrl);
  const urls = parseListUrls(listHtml);
  console.error(`[ma-festival] ${urls.length} URLs distinctes`);

  let kept = 0;
  let skippedConcertgebouw = 0;
  let skippedRejectTitle = 0;
  let skippedNoDate = 0;
  let skippedPast = 0;
  const concerts = [];
  for (const url of urls) {
    try {
      const html = await fetchHtml(url);
      const detail = parseDetailFirst(html, composerIndex);
      await sleep(detailDelay);
      if (!detail.date) { skippedNoDate++; continue; }
      // Hors fenêtre éditoriale du festival (31 juillet → 9 août 2026) :
      // on rejette pour ne pas remonter des concerts liés/satellites
      // datés en mai/juin qui apparaissent parfois dans la page détail.
      if (detail.date < '2026-07-31' || detail.date > '2026-08-09') { skippedPast++; continue; }
      if (detail.date < today) { skippedPast++; continue; }
      if (TITLE_REJECT_PATTERNS.some((re) => re.test(detail.title))) {
        skippedRejectTitle++;
        continue;
      }
      // Si le concert se déroule au Concertgebouw Brugge, on le laisse à
      // cgbrugge.js (le tag festival sera appliqué via festivals.json
      // dans aggregate.js). Évite le doublon.
      if (detail.venue && /concertgebouw/i.test(detail.venue)) {
        skippedConcertgebouw++;
        continue;
      }
      kept++;
      concerts.push({
        id: buildId(detail.date, url, detail.time),
        source: 'ma-festival',
        venue_id: 'ma-festival',
        title: detail.title,
        date: detail.date,
        time: detail.time,
        url,
        composers: detail.composers,
        performers: [],
        program: detail.venue ? `${detail.program} — ${detail.venue}` : detail.program,
        price_min: null,
        price_max: null,
        scraped_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[ma-festival] detail failed for ${url}: ${err.message}`);
    }
  }

  console.error(`[ma-festival] retenus ${kept} | skip Concertgebouw ${skippedConcertgebouw} (déjà dans cgbrugge.js, taggés via festivals.json) | skip compétition/cours ${skippedRejectTitle} | skip pas de date ${skippedNoDate} | skip passés ${skippedPast}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeMAFestival()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
