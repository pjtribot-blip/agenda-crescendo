// Scraper OstbelgienFestival (OBF) — communauté germanophone de Belgique
//
// Festival saison étendue mai → décembre, programmation 100% classique
// répartie sur plusieurs lieux : Triangel St-Vith (la base), Kelmis,
// Eupen, sentiers de randonnée Eifel ("Wanderkonzert"), Le Pavillon
// (Heuem), etc.
//
// CMS : Joomla + JEM (Joomla Event Management). Liste plate sur
// /fr/agenda, ~22 événements à venir. URL détail :
//   /fr/component/jem/event/{ID}-{slug}?Itemid=145
//
// Détail page :
//   <meta itemprop="startDate" content="2026-06-27T20:00" />
//   <div class="event-detail-venue">…<span>VENUE NAME</span>
//        <div class="event-detail-venue_details">ADDRESS…</div>
//   </div>
//
// Mapping venue_id (par nom de venue détecté) :
//   "Triangel" / "Kulturzentrum Triangel" → triangel (existant Phase 3.11)
//   "Eupen" / nom contenant Eupen → eupen (créé)
//   "Kelmis" → kelmis (créé)
//   autre → "obf-festival" umbrella (créé), program = nom venue raw
//
// Dédoublonnage avec triangel.js : la passe finale dans aggregate.js
// retire les concerts triangel dont (date, time, normalize-title-prefix)
// matche un concert obf. OBF prime (source plus complète : programme,
// interprètes, prix).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://obf.be';
const LIST_PATH = '/fr/agenda';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Mapping nom-venue → venue_id. Test dans l'ordre, premier match gagne.
const VENUE_MAP = [
  { re: /triangel/i, id: 'triangel' },
  { re: /kelmis|la calamine/i, id: 'kelmis' },
  { re: /eupen/i, id: 'eupen' },
];

// Hard reject : pédagogique jeune public, expositions
const TITLE_REJECT_PATTERNS = [
  /concerts? p[eé]dagogiques?/i,
  /^exposition\b/i,
  /Ausstellung/i,
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
  return (s || '')
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
// List parsing
// ------------------------------------------------------------------
function parseListUrls(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $('.event-item a[href*="/component/jem/event/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    urls.add(url);
  });
  return [...urls];
}

// ------------------------------------------------------------------
// Detail parsing
// ------------------------------------------------------------------
function parseDetail(html) {
  const $ = cheerio.load(html);
  const startMeta = $('meta[itemprop="startDate"]').first().attr('content') || '';
  const m = startMeta.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/);
  const date = m ? m[1] : null;
  const time = m && m[2] && m[3] ? `${m[2]}:${m[3]}` : null;

  const title = $('.event-detail-header h1, h1').first().text().trim().replace(/\s+/g, ' ');

  // Venue : .event-detail-venue contient <span>/&nbsp;&nbsp;</span>VENUE NAME
  // suivi du <div class="event-detail-venue_details">. On extrait le
  // texte direct de .event-detail-venue avant le sous-div.
  const $venue = $('.event-detail-venue').first();
  let venueName = '';
  if ($venue.length) {
    // Clone et retire les sous-divs pour ne garder que le texte du nom
    const cloned = $venue.clone();
    cloned.find('.event-detail-venue_details').remove();
    // Le HTML rend "<span>/&nbsp;&nbsp;</span>VENUE_NAME" donc le texte
    // commence par "/" + nbsp. On normalise puis on strip le préfixe.
    venueName = cloned.text().replace(/\s+/g, ' ').trim().replace(/^\/\s*/, '').trim();
  }

  const description = $('[itemprop="description"], .jem_event_description, .event-detail-body').first().text().replace(/\s+/g, ' ').trim().slice(0, 800);

  return { date, time, title, venueName, description };
}

function mapVenue(name) {
  if (!name) return { id: 'obf-festival', label: null };
  for (const { re, id } of VENUE_MAP) {
    if (re.test(name)) return { id, label: name };
  }
  return { id: 'obf-festival', label: name };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url, time) {
  const m = url.match(/\/event\/(\d+)-([^?]+)/);
  const slug = m ? m[2] : 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `obf-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeOBF({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const listUrl = `${BASE_URL}${LIST_PATH}`;
  console.error(`[obf] list ${listUrl}`);
  const listHtml = await fetchHtml(listUrl);
  const urls = parseListUrls(listHtml);
  console.error(`[obf] ${urls.length} URLs distinctes`);

  const concerts = [];
  let past = 0, rejected = 0;
  for (const url of urls) {
    let html;
    try { html = await fetchHtml(url); }
    catch (err) {
      console.error(`[obf]   échec ${url} : ${err.message}`);
      continue;
    }
    const d = parseDetail(html);
    if (!d.date) continue;
    if (d.date < today) { past++; continue; }
    if (TITLE_REJECT_PATTERNS.some((re) => re.test(d.title))) { rejected++; continue; }

    const v = mapVenue(d.venueName);
    const composers = matchComposers(`${d.title} ${d.description.slice(0, 1500)}`, composerIndex);
    concerts.push({
      id: buildId(d.date, url, d.time),
      source: 'obf',
      venue_id: v.id,
      title: d.title,
      date: d.date,
      time: d.time,
      url,
      composers,
      performers: [],
      program: v.label
        ? `${v.label}${d.description ? ' — ' + d.description.slice(0, 180) : ''}`
        : (d.description.slice(0, 200) || null),
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
    await sleep(200);
  }

  console.error(`[obf] retenus ${concerts.length} | passés ${past} | rejetés ${rejected}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeOBF()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
