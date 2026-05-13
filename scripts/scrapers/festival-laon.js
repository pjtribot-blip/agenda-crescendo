// Scraper Festival de Laon (ADAMA, 38e édition automne 2026)
//
// Site WordPress + thème Bridge + Elementor — même CMS et même
// webmaster (Maxime Delalande) que le Festival de Saint-Michel-en-
// Thiérache (Phase 3.8). Architecture quasi-identique :
//   /programme-billetterie/                 → hub avec les liens jour
//   /programme-billetterie/{slug-date}/     → page détail journée
//                                              (ex. jeudi-11-septembre-2026)
//
// Au 12 mai 2026, la programmation 2026 n'est pas encore publiée
// sur le site (toutes les URLs visibles datent de 2025). Le scraper
// est opérationnel mais retourne actuellement 0 concerts — il se
// réveillera automatiquement quand la programmation 2026 sera mise
// en ligne (typiquement juin-juillet 2026 pour un festival d'automne).
//
// Pour le parsing des pages détail, on réutilise la stratégie
// Elementor : chercher les pairs (HHhMM, titre suivant) jusqu'au
// marqueur "Nous vous proposons également" / "Déjeuner" /
// "Rencontre artistes" qui sépare concerts vs accessoires.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://festival-laon.org';
const LIST_PATH = '/programme-billetterie/';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  février: 2, août: 8, décembre: 12,
};

// Mapping nom-lieu (parsé sur fiche détail) → venue_id.
const VENUE_MAP = [
  { re: /cit[eé]\s+de\s+la\s+musique.{0,20}soissons/i, id: 'cite-musique-soissons' },
  { re: /soissons/i,                                    id: 'cite-musique-soissons' },
];
const DEFAULT_VENUE = 'festival-laon';

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
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014', eacute: 'é', egrave: 'è',
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
// Hub parsing : récupère les URLs de pages jour pour l'année courante
// (et future si publiée).
// ------------------------------------------------------------------
function parseHub(html, currentYear) {
  const $ = cheerio.load(html);
  const urls = new Set();
  const dateInfo = new Map();
  $('a[href*="/programme-billetterie/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    // Format /programme-billetterie/{jour}-{DD}-{mois}-{YYYY}/
    const m = href.match(/\/programme-billetterie\/([a-z]+)-(\d{1,2})-([a-zéûô]+)-(\d{4})\/?$/i);
    if (!m) return;
    const year = parseInt(m[4], 10);
    if (year < currentYear) return;     // ignore éditions passées
    const monthNum = MONTHS_FR[normalize(m[3]).replace(/\.$/, '')];
    if (!monthNum) return;
    const date = `${m[4]}-${String(monthNum).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    const url = href.startsWith('http') ? href : BASE_URL + href;
    if (urls.has(url)) return;
    urls.add(url);
    dateInfo.set(url, date);
  });
  return [...urls].map((url) => ({ url, date: dateInfo.get(url) }));
}

// ------------------------------------------------------------------
// Day page parsing — Elementor headings (cf. festival-st-michel.js)
// ------------------------------------------------------------------
function parseDayPage(html) {
  const $ = cheerio.load(html);
  const headings = [];
  $('.elementor-heading-title').each((_, el) => {
    const t = decodeEntities($(el).text().trim()).replace(/\s+/g, ' ');
    if (t) headings.push(t);
  });
  const cutIdx = headings.findIndex((h) => /nous vous proposons|d[eé]jeuner|rencontre.{0,30}artistes|formule|billetterie/i.test(h));
  const before = cutIdx >= 0 ? headings.slice(0, cutIdx) : headings;

  let theme = '';
  for (let i = 0; i < before.length; i++) {
    if (/^\d{1,2}h\d{0,2}$/i.test(before[i])) break;
    if (/^\d{1,2}\s+\w+\s+\d{4}$/i.test(before[i])) continue;
    if (/^\d+\s+concerts?$/i.test(before[i])) continue;
    if (!theme) { theme = before[i]; }
  }

  const concerts = [];
  for (let i = 0; i < before.length - 1; i++) {
    const m = before[i].match(/^(\d{1,2})\s*h\s*(\d{0,2})$/i);
    if (!m) continue;
    const hh = m[1].padStart(2, '0');
    const mm = (m[2] || '00').padStart(2, '0');
    const time = `${hh}:${mm}`;
    let next = '';
    for (let j = i + 1; j < before.length; j++) {
      if (/^\d{1,2}\s*h\s*\d{0,2}$/i.test(before[j])) break;
      if (before[j].length > 2 && before[j].length < 200) { next = before[j]; break; }
    }
    if (next) concerts.push({ time, title: next });
  }

  // Cherche un nom de lieu dans l'ensemble de la page
  const fullText = $('body').text().replace(/\s+/g, ' ');
  let venueLabel = '';
  for (const re of [/cath[eé]drale\s+(?:notre[-\s]dame\s+)?de\s+laon/i, /[eé]glise\s+saint[-\s]martin\s+de\s+laon/i, /conservatoire\s+du\s+pays\s+de\s+laon/i, /maison\s+des\s+arts.{0,20}laon/i, /cit[eé]\s+de\s+la\s+musique.{0,20}soissons/i]) {
    const m = fullText.match(re);
    if (m) { venueLabel = m[0]; break; }
  }

  return { theme, concerts, venueLabel };
}

function mapVenue(venueLabel) {
  if (!venueLabel) return { id: DEFAULT_VENUE, label: '' };
  for (const { re, id } of VENUE_MAP) {
    if (re.test(venueLabel)) return { id, label: venueLabel };
  }
  return { id: DEFAULT_VENUE, label: venueLabel };
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
  return `laon-${date}${t}${i}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeFestivalLaon({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();
  const currentYear = new Date().getFullYear();

  const hubUrl = `${BASE_URL}${LIST_PATH}`;
  console.error(`[laon] hub ${hubUrl}`);
  let hubHtml;
  try { hubHtml = await fetchHtml(hubUrl); }
  catch (err) { console.error(`[laon]   échec hub : ${err.message}`); return []; }

  const dayPages = parseHub(hubHtml, currentYear);
  console.error(`[laon] ${dayPages.length} pages jour ${currentYear}+ détectées`);

  const concerts = [];
  for (const { url, date } of dayPages) {
    if (date < today) continue;
    let html;
    try { html = await fetchHtml(url); }
    catch (err) {
      console.error(`[laon]   échec ${url} : ${err.message}`);
      continue;
    }
    const parsed = parseDayPage(html);
    if (!parsed.concerts.length) continue;

    // Dédupe desktop/mobile Elementor (rendu deux fois)
    const seenKey = new Set();
    parsed.concerts = parsed.concerts.filter((c) => {
      const k = `${c.time}|${normalize(c.title).slice(0, 50)}`;
      if (seenKey.has(k)) return false;
      seenKey.add(k);
      return true;
    });

    const v = mapVenue(parsed.venueLabel);
    const slug = (url.match(/\/programme-billetterie\/([^/?#]+)/) || [])[1] || 'event';
    parsed.concerts.forEach((c, idx) => {
      const composers = matchComposers(`${c.title} ${parsed.theme}`, composerIndex);
      concerts.push({
        id: buildId(date, slug, c.time, idx + 1),
        source: 'festival-laon',
        venue_id: v.id,
        title: `${parsed.theme ? parsed.theme + ' — ' : ''}${c.title}`.slice(0, 200),
        date,
        time: c.time,
        url,
        composers,
        performers: [],
        program: v.label || parsed.theme || null,
        price_min: null,
        price_max: null,
        scraped_at: new Date().toISOString(),
      });
    });
    await sleep(250);
  }

  console.error(`[laon] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeFestivalLaon()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
