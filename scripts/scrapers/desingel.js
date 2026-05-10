// Scraper deSingel — agenda musique
//
// deSingel est un campus pluridisciplinaire (musique, danse, théâtre,
// architecture). Le site est une SPA Angular dont la page programme
// charge ses événements via une API Postgres-proxy à `/api/data`. On
// utilise directement cette API en query de table production__c +
// activity__c (filtrage côté serveur sur productiontypetext__c='Muziek').
//
//  1. Productions : on récupère toutes les productions Muziek dont
//     productionstart__c >= aujourd'hui.
//  2. Activités : pour chaque production, on récupère les représentations
//     dans activity__c (sfid lien production__c). Une production peut
//     avoir N activités (multi-soirs).
//  3. On émet un concert par activité.
//
// Filtre éditorial : la rubrique "Muziek" inclut tout — classique,
// contemporain, jazz, etc. À deSingel, le sous-genre n'est pas exposé
// dans les colonnes API que j'ai pu cartographier ; on garde tout. Si
// du jazz/world apparaît, on filtrera par titre comme pour Grand Manège.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://desingel.be';
const API_PATH = '/api/data';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// ------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------
async function fetchText(url, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
          'Accept-Language': 'nl-BE,nl;q=0.9,fr;q=0.8',
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

async function fetchJson(url, opts) {
  const txt = await fetchText(url, opts);
  return JSON.parse(txt);
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
// API helpers
// ------------------------------------------------------------------
function buildDataUrl(query) {
  return `${BASE_URL}${API_PATH}?query=${encodeURIComponent(JSON.stringify(query))}`;
}

async function queryProductions(today) {
  const query = {
    object: 'production__c',
    where: [
      { field: 'productionstart__c', comparison: '>=', value: today },
      { field: 'productiontypetext__c', comparison: '=', value: 'Muziek' },
    ],
    order: [{ field: 'productionstart__c', order: 'ASC' }],
    fields: [
      'sfid',
      'name',
      'shorttitle__c',
      'productionstart__c',
      'productionstop__c',
      'systemurlnl__c',
      'productiontypetext__c',
    ],
    limit: 500,
  };
  const data = await fetchJson(buildDataUrl(query));
  if (data.status !== 'success') throw new Error(`production query failed: ${JSON.stringify(data.error || data).slice(0, 200)}`);
  return data.rows || [];
}

async function queryActivities(productionSfids, today) {
  if (productionSfids.length === 0) return [];
  // Activity n'autorise pas tous les champs ; on prend ce qui marche.
  const query = {
    object: 'activity__c',
    where: [
      { field: 'production__c', comparison: 'IN', value: productionSfids },
      { field: 'activitystart__c', comparison: '>=', value: today },
    ],
    order: [{ field: 'activitystart__c', order: 'ASC' }],
    fields: ['sfid', 'activitystart__c', 'activitystop__c', 'production__c'],
    limit: 1000,
  };
  const data = await fetchJson(buildDataUrl(query));
  if (data.status !== 'success') throw new Error(`activity query failed: ${JSON.stringify(data.error || data).slice(0, 200)}`);
  return data.rows || [];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function isoDateTime(s) {
  // "2026-05-10T13:00:00.000Z" → date "2026-05-10", time "13:00" (UTC, accepté)
  if (!s) return { date: null, time: null };
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return { date: null, time: null };
  return { date: m[1], time: `${m[2]}:${m[3]}` };
}

function buildId(date, prodSfid, time) {
  const t = time ? `-${time.replace(':', '')}` : '';
  return `desingel-${date}${t}-${prodSfid.slice(0, 18)}`.slice(0, 200);
}

function buildUrl(systemurlnl) {
  if (!systemurlnl) return BASE_URL;
  // ex: "nl/programma/muziek/echo-2025"
  const path = systemurlnl.startsWith('/') ? systemurlnl : '/' + systemurlnl;
  return BASE_URL + path;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeDeSingel({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  console.error(`[desingel] productions Muziek >= ${today}`);
  const productions = await queryProductions(today);
  console.error(`[desingel] ${productions.length} productions`);

  const sfids = productions.map((p) => p.sfid);
  const activities = await queryActivities(sfids, today);
  console.error(`[desingel] ${activities.length} activités`);

  const productionsById = new Map(productions.map((p) => [p.sfid, p]));

  const concerts = [];
  const seenKey = new Set();
  for (const act of activities) {
    const prod = productionsById.get(act.production__c);
    if (!prod) continue;
    const { date, time } = isoDateTime(act.activitystart__c);
    if (!date) continue;
    const url = buildUrl(prod.systemurlnl__c);
    const key = `${prod.sfid}|${date}|${time || ''}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    const title = prod.name || '(?)';
    const composers = matchComposers(title, composerIndex);

    concerts.push({
      id: buildId(date, prod.sfid, time),
      source: 'desingel',
      venue_id: 'desingel',
      title,
      date,
      time,
      url,
      composers,
      performers: [],
      program: prod.shorttitle__c || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
  }

  // Pour les productions sans activité (cas peu fréquent : production
  // affichée mais sans activité indexée), on émet une entrée à la
  // productionstart__c.
  const prodsWithActivity = new Set(activities.map((a) => a.production__c));
  for (const prod of productions) {
    if (prodsWithActivity.has(prod.sfid)) continue;
    const { date, time } = isoDateTime(prod.productionstart__c);
    if (!date || date < today) continue;
    const url = buildUrl(prod.systemurlnl__c);
    const composers = matchComposers(prod.name || '', composerIndex);
    concerts.push({
      id: buildId(date, prod.sfid, time),
      source: 'desingel',
      venue_id: 'desingel',
      title: prod.name || '(?)',
      date,
      time,
      url,
      composers,
      performers: [],
      program: prod.shorttitle__c || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
  }

  console.error(`[desingel] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeDeSingel()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
