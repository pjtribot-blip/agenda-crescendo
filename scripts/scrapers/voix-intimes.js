// Scraper Festival Les Voix Intimes (Proquartetto, Tournai)
//
// 24e édition "Indivisible by Four" — saison 25-26 (nov 2025 → mars
// 2026) + cycle "Les Midis du Quatuor 2026" (août 2026 à la Chapelle
// de la Madeleine de Tournai).
//
// Site WordPress https://proquartetto.be. La page /indivisible-by-four/
// liste les fiches d'événements /evenements/SLUG. Chaque fiche contient
// quelque part dans son corps : "DD/MM/YYYY HH:MM Nom-du-lieu" (format
// libre mais constant).
//
// Stratégie : on collecte les URLs depuis /indivisible-by-four/ + on
// ajoute /les-midis-du-quatuor-2026/ (page spécifique du cycle d'été
// si elle expose les 3 événements naka/galilee/desguin). Pour chaque
// fiche : extraction du premier "DD/MM/YYYY HH:MM venue" du body.
//
// Attribution venue :
//   - "Maison de la Culture de Tournai" → mctournai (déjà scrapé)
//     → SKIP (les concerts y sont taggés via festivals.json)
//   - "Conservatoire de Tournai" → conservatoire-tournai
//   - autres ("Maisons romanes de Tournai", "Chapelle de la Madeleine"…)
//     → voix-intimes-tournai (umbrella)

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://proquartetto.be';
const HUB_PATHS = ['/indivisible-by-four/', '/les-midis-du-quatuor-2026/'];

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
      if (res.status === 404) return null;
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
// Hub parsing — collect event URLs
// ------------------------------------------------------------------
function parseHubUrls(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $('a[href*="/evenements/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!/proquartetto\.be\/evenements\//.test(href)) return;
    // Filtre les copies/staging du sous-domaine kobold-studio.be
    if (/kobold-studio\.be/.test(href)) return;
    urls.add(href.replace(/\/$/, ''));
  });
  return [...urls];
}

// ------------------------------------------------------------------
// Detail parsing — first dated line "DD/MM/YYYY HH:MM venue"
// ------------------------------------------------------------------
function parseDetail(html, composerIndex) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim().replace(/\s+/g, ' ');
  const text = $('body').text().replace(/\s+/g, ' ');

  const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})[:hH](\d{2})\s+([A-ZÀ-ÿ][\w\sÀ-ÿ\-'’,.]{3,80})/);
  let date = null, time = null, venueName = null;
  if (m) {
    date = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    time = `${m[4].padStart(2,'0')}:${m[5]}`;
    venueName = m[6].replace(/\s+/g, ' ').trim();
  }

  // Description : on prend le 1er paragraphe du contenu principal.
  const desc = $('p').toArray()
    .map((p) => $(p).text().replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 50)
    .slice(0, 2)
    .join(' ');

  const composers = matchComposers(`${title} ${desc.slice(0, 1500)}`, composerIndex);
  return { title, date, time, venueName, desc, composers };
}

function venueIdFromName(name) {
  if (!name) return 'voix-intimes-tournai';
  const n = normalize(name);
  if (/maison de la culture/.test(n)) return 'mctournai';
  if (/conservatoire/.test(n)) return 'conservatoire-tournai';
  return 'voix-intimes-tournai';
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
  return `voix-intimes-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeVoixIntimes({
  detailDelay = 350,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // Collecte les URLs depuis les hubs
  const allUrls = new Set();
  for (const hubPath of HUB_PATHS) {
    const url = `${BASE_URL}${hubPath}`;
    try {
      console.error(`[voix-intimes] hub ${hubPath}`);
      const html = await fetchHtml(url);
      if (html) parseHubUrls(html).forEach((u) => allUrls.add(u));
    } catch (err) {
      console.error(`[voix-intimes] hub ${hubPath} failed: ${err.message}`);
    }
    await sleep(250);
  }
  console.error(`[voix-intimes] ${allUrls.size} fiches`);

  let kept = 0, skippedMc = 0, skippedNoDate = 0, skippedPast = 0;
  const concerts = [];
  for (const url of allUrls) {
    try {
      const html = await fetchHtml(url);
      if (!html) continue;
      const detail = parseDetail(html, composerIndex);
      await sleep(detailDelay);
      if (!detail.date) { skippedNoDate++; continue; }
      if (detail.date < today) { skippedPast++; continue; }
      const venueId = venueIdFromName(detail.venueName);
      // On laisse mctournai à tournai.js (taggé via festivals.json) pour
      // ne pas créer de doublon. Cas rare à Voix Intimes mais possible.
      if (venueId === 'mctournai') { skippedMc++; continue; }
      kept++;
      concerts.push({
        id: buildId(detail.date, url, detail.time),
        source: 'voix-intimes',
        venue_id: venueId,
        title: detail.title,
        date: detail.date,
        time: detail.time,
        url,
        composers: detail.composers,
        performers: [],
        program: detail.venueName ? `${detail.desc.slice(0, 250)} — ${detail.venueName}` : detail.desc.slice(0, 250),
        price_min: null,
        price_max: null,
        scraped_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[voix-intimes] detail failed for ${url}: ${err.message}`);
    }
  }

  console.error(`[voix-intimes] retenus ${kept} | skip Maison Culture (taggé via festivals.json) ${skippedMc} | skip pas de date ${skippedNoDate} | skip passés ${skippedPast}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeVoixIntimes()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
