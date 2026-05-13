// Scraper OPRL — Orchestre Philharmonique Royal de Liège
//
// Stratégie :
//  1. Liste : on itère sur /fr/concerts?date=YYYY-MM tous les 2 mois (chaque
//     requête renvoie une fenêtre roulante de ~3 mois). On dédupe ensuite.
//  2. Filtre éditorial très simple — l'OPRL ne programme que de la musique
//     classique. On exclut juste deux séries :
//       - series-symphokids = concerts jeune public
//       - series-dumonde    = "Musiques du monde"
//     Toutes les autres séries (default, orchestre, factory, midi, samedi,
//     happyhour, piano, orgue, deplacement) sont gardées.
//  3. Détail : on visite chaque page concert une fois (cache par URL) pour
//     récupérer la liste structurée des interprètes (avec rôles), le
//     programme détaillé (compositeurs + œuvres) et le prix.
//  4. La date et l'heure sont déjà dans la liste (classes concert-date-… +
//     <time datetime>). On émet un concert par occurrence.
//
// Cas particulier : series-deplacement = concerts décentralisés (Verviers,
// Eupen, Bruxelles, etc.). On garde mais le champ "lieu" reflète la salle
// hors Liège. À ce stade tout est mappé vers venue_id "oprl" — on isolera
// ces lieux dans des venues séparées plus tard si besoin.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.oprl.be';
const LIST_PATH = '/fr/concerts';

const REJECT_SERIES = new Set(['symphokids', 'dumonde']);

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
          'Accept-Language': 'fr-BE,fr;q=0.9,en;q=0.8',
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

function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// ------------------------------------------------------------------
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('article.node--type-concert').each((_, el) => {
    const $el = $(el);
    const klass = $el.attr('class') || '';
    const dateMatch = klass.match(/concert-date-(\d{4})(\d{2})(\d{2})/);
    if (!dateMatch) return;
    const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    const seriesMatch = klass.match(/series-([a-z]+)/);
    const series = seriesMatch ? seriesMatch[1] : 'default';

    const $titleA = $el.find('.field--name-title h2 a').first();
    const title = $titleA.text().trim().replace(/\s+/g, ' ');
    const href = $titleA.attr('href') || '';
    if (!href || !title) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;

    // Heure (peut y en avoir plusieurs ; on prend la première)
    const timeText = $el.find('.concert-hours time').first().attr('datetime') || '';
    const tm = timeText.match(/T(\d{2}):(\d{2})/);
    const time = tm ? `${tm[1]}:${tm[2]}` : null;

    const lieu = $el.find('.field--name-field-lieu .field__item').first().text().trim() || null;
    const teaser = $el.find('.field--name-body').first().text().trim().replace(/\s+/g, ' ');
    const hashtags = $el.find('.field--name-field-hashtags .field__item').toArray()
      .map((t) => $(t).text().trim());

    items.push({ url, title, date, time, series, lieu, teaser, hashtags });
  });

  return items;
}

function isAllowed(item) {
  return !REJECT_SERIES.has(item.series);
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseDetailPage(html, composerIndex) {
  const $ = cheerio.load(html);

  // Programme : <div id="program"> contient <div class="field--name-field-description"><p>…</p>
  const programmeText = $('#program .field--name-field-description').first()
    .text().replace(/\s+/g, ' ').trim();

  // Interprètes : chaque .field--name-field-interpretes > .field__item article
  // a un <span class="link-title">Nom</span><span class="link-suffix">rôle</span>
  const performers = [];
  $('.field--name-field-interpretes > .field__item').each((_, el) => {
    const $el = $(el);
    const name = $el.find('.link-title').first().text().trim();
    const role = $el.find('.link-suffix').first().text().trim();
    if (!name) return;
    performers.push(role ? `${name} (${role})` : name);
  });

  // Prix : <div class="field--name-field-pricing">…<div class="field__item">19 €</div>
  const priceText = $('.field--name-field-pricing .field__item').first().text().trim();
  const nums = (priceText.match(/(\d+)/g) || []).map((n) => parseInt(n, 10));
  const priceMin = nums.length ? Math.min(...nums) : null;
  const priceMax = nums.length ? Math.max(...nums) : null;

  // Compositeurs : matching uniquement dans le programme structuré, pas dans
  // le titre (évite les faux positifs type "Mendelssohn Quartet").
  const composers = matchComposers(programmeText, composerIndex);

  return { programmeText, performers, priceMin, priceMax, composers };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

// Génère une liste de YYYY-MM tous les step mois sur N mois.
function monthSteps(months, step = 2) {
  const out = [];
  const now = new Date();
  for (let i = 0; i <= months; i += step) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    out.push(`${y}-${m}`);
  }
  return out;
}

function buildId(date, url) {
  const slug = (url.match(/\/concerts\/([^/?#]+)/) || [])[1] || 'event';
  return `oprl-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeOPRL({
  monthsAhead = 14,
  monthStep = 2,
  detailDelay = 350,
  pageDelay = 250,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  let listed = [];
  for (const monthStr of monthSteps(monthsAhead, monthStep)) {
    const url = `${BASE_URL}${LIST_PATH}?date=${monthStr}`;
    try {
      console.error(`[oprl] list ${monthStr}`);
      const html = await fetchHtml(url);
      const items = parseListPage(html);
      listed.push(...items);
    } catch (err) {
      console.error(`[oprl] list ${monthStr} failed: ${err.message}`);
    }
    await sleep(pageDelay);
  }

  // Dédupe par (url, date, time) — chaque fenêtre roulante recouvre la
  // précédente.
  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  const allowed = upcoming.filter(isAllowed);
  const rejected = upcoming.length - allowed.length;
  console.error(`[oprl] ${listed.length} listés / ${upcoming.length} à venir / ${allowed.length} retenus (rejet symphokids+dumonde: ${rejected})`);

  // Statistiques décentralisation (info pour le commit)
  const offSite = allowed.filter((it) => it.series === 'deplacement');
  if (offSite.length) {
    console.error(`[oprl] ${offSite.length} concerts décentralisés (series-deplacement) — gardés mais venue_id=oprl :`);
    for (const it of offSite.slice(0, 5)) {
      console.error(`  - ${it.date} ${it.title} → ${it.lieu || '?'}`);
    }
    if (offSite.length > 5) console.error(`  …et ${offSite.length - 5} autres`);
  }

  // Détail (cache par URL)
  const detailCache = new Map();
  const concerts = [];
  for (const item of allowed) {
    let detail = detailCache.get(item.url);
    if (!detail) {
      try {
        const html = await fetchHtml(item.url);
        detail = parseDetailPage(html, composerIndex);
        detailCache.set(item.url, detail);
        await sleep(detailDelay);
      } catch (err) {
        console.error(`[oprl] detail failed for ${item.url}: ${err.message}`);
        detail = null;
      }
    }

    concerts.push({
      id: buildId(item.date, item.url),
      source: 'oprl',
      venue_id: 'oprl',
      title: item.title,
      date: item.date,
      time: item.time,
      url: item.url,
      composers: detail?.composers || [],
      performers: detail?.performers || [],
      program: detail?.programmeText || item.teaser || null,
      price_min: detail?.priceMin ?? null,
      price_max: detail?.priceMax ?? null,
      scraped_at: new Date().toISOString(),
    });
  }

  console.error(`[oprl] ${concerts.length} concerts produits`);
  return concerts;
}

// CLI direct execution: print JSON to stdout (logs go to stderr)
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeOPRL()
    .then((concerts) => {
      process.stdout.write(JSON.stringify(concerts, null, 2) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
