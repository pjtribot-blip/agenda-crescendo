// Scraper Atelier Lyrique de Tourcoing
//
// Stratégie :
//  1. Liste : on visite les 4-5 sous-pages de catégorie de la saison en
//     cours (`/saison-atelier-lyrique-25-26/operas/`,
//     `/musique-ancienne/`, `/recital-lyrique/`, `/concerts-et-concerts-en-famille/`,
//     `/comedies-musicales/`, `/spectacle/`). Chaque sous-page liste
//     ses spectacles dans des <article>.
//  2. La date est encodée dans le titre / l'URL : "GASPARINI Atalia
//     – 28 mai 2026" ou "FESTIVAL CHANTS LIBRES- 26-27-28 juin 2026".
//     On parse cette chaîne pour récupérer une à plusieurs dates.
//  3. Filtre éditorial : Tourcoing est une petite scène lyrique
//     baroque/contemporain ; tout ce qui apparaît dans saison passe.
//     On garde la catégorie comme info.
//  4. Pas de page détail — la page sait suffisamment et l'enrichissement
//     ne vaut pas un fetch de 1.2 MB par production (RevSlider lourd).

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.atelierlyriquedetourcoing.fr';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Sous-catégories à visiter pour la saison en cours (ordre = priorité
// catégorielle si une production apparaît plusieurs fois)
const CATEGORIES = [
  { slug: 'operas', label: 'Opéra' },
  { slug: 'musique-ancienne', label: 'Musique ancienne' },
  { slug: 'recital-lyrique', label: 'Récital lyrique' },
  { slug: 'concerts-et-concerts-en-famille', label: 'Concert' },
  { slug: 'comedies-musicales', label: 'Comédie musicale' },
  { slug: 'spectacle', label: 'Spectacle' },
];

// Détection automatique de la saison en cours via l'URL racine
const SEASON_PATHS = ['saison-atelier-lyrique-25-26', 'saison-atelier-lyrique-26-27'];

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
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
          'Accept-Language': 'fr-FR,fr;q=0.9',
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
// Date parsing — extrait toutes les dates d'un titre comme :
//   "GASPARINI Atalia – 28 mai 2026"
//   "FESTIVAL CHANTS LIBRES- 26-27-28 juin 2026"
//   "RAMEAU Les Boréades – 3 juin 2026"
// ------------------------------------------------------------------
function parseDatesFromTitle(title) {
  if (!title) return [];
  // Format multi-jours : "26-27-28 juin 2026"
  const multi = title.match(/(\d{1,2}(?:-\d{1,2})+)\s+([a-zéûô]+)\s+(\d{4})/i);
  if (multi) {
    const days = multi[1].split('-').map((d) => parseInt(d, 10));
    const month = MONTHS_FR[normalize(multi[2])];
    const year = parseInt(multi[3], 10);
    if (month) {
      return days.map((d) => `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    }
  }
  // Format simple : "28 mai 2026"
  const single = title.match(/(\d{1,2})\s+([a-zéûô]+)\s+(\d{4})/i);
  if (single) {
    const day = parseInt(single[1], 10);
    const month = MONTHS_FR[normalize(single[2])];
    const year = parseInt(single[3], 10);
    if (month) {
      return [`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`];
    }
  }
  return [];
}

// Nettoie le titre en retirant le suffixe de date
function cleanTitle(title) {
  return title
    .replace(/\s*[-–—]\s*\d{1,2}(?:-\d{1,2})*\s+[a-zéûô]+\s+\d{4}\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('article').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a.w-grid-item-anchor, h2 a, h3 a').first();
    let href = $a.attr('href') || '';
    if (!href) {
      // fallback: any anchor inside
      href = $el.find('a[href*="atelierlyriquedetourcoing.fr"]').first().attr('href') || '';
    }
    if (!href) return;
    if (!/atelierlyriquedetourcoing\.fr/.test(href)) return;
    if (/\/(saison|tarifs|abonnement|jeune-public|brochure|brochure-saison|saison-atelier)/.test(href)) return;
    const url = href;
    const titleRaw = $el.find('h2, h3').first().text().trim().replace(/\s+/g, ' ');
    if (!titleRaw) return;
    items.push({ url, titleRaw });
  });
  return items;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/([^/]+)\/?$/) || [])[1] || 'event';
  return `tourcoing-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeTourcoing({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // Collecte par catégorie, dédupe par URL en gardant la 1ère catégorie
  // rencontrée (priorité = ordre du tableau CATEGORIES).
  const productions = new Map(); // url → {url, titleRaw, category}
  for (const seasonPath of SEASON_PATHS) {
    for (const cat of CATEGORIES) {
      const url = `${BASE_URL}/${seasonPath}/${cat.slug}/`;
      try {
        console.error(`[tourcoing] ${seasonPath}/${cat.slug}`);
        const html = await fetchHtml(url);
        if (!html) continue;
        const items = parseListPage(html);
        for (const it of items) {
          if (productions.has(it.url)) continue;
          productions.set(it.url, { ...it, category: cat.label });
        }
      } catch (err) {
        console.error(`[tourcoing] ${seasonPath}/${cat.slug} failed: ${err.message}`);
      }
      await sleep(250);
    }
  }
  console.error(`[tourcoing] ${productions.size} productions distinctes`);

  // Émission : 1 concert par date parsée du titre
  const concerts = [];
  for (const item of productions.values()) {
    const dates = parseDatesFromTitle(item.titleRaw);
    if (dates.length === 0) {
      console.error(`[tourcoing] aucune date parsée pour : ${item.titleRaw} (${item.url})`);
      continue;
    }
    const title = cleanTitle(item.titleRaw);
    const composers = matchComposers(title, composerIndex);
    for (const date of dates) {
      if (date < today) continue;
      concerts.push({
        id: buildId(date, item.url),
        source: 'tourcoing',
        venue_id: 'altourcoing',
        title,
        date,
        time: null,
        url: item.url,
        composers,
        performers: [],
        program: item.category || null,
        price_min: null,
        price_max: null,
        scraped_at: new Date().toISOString(),
      });
    }
  }

  console.error(`[tourcoing] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeTourcoing()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
