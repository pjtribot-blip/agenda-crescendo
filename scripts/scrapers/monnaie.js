// Scraper La Monnaie — agenda opéra / concerts
//
// Stratégie :
//  1. Liste : on itère sur /fr/calendar?m=YYYY-MM du mois courant à +14 mois.
//     Chaque <li class="list-item"> représente une représentation datée (id
//     "day_YYYYMMDD"), avec titre, heure, catégorie (Opéra, Musique de
//     chambre, Songs, Concert, Événement, Visites guidées, Kids…) et lien
//     vers la page programme.
//  2. Filtre éditorial : on garde si la catégorie contient l'un des marqueurs
//     classiques (Opéra, Symphonique, Musique de chambre, Récital, Songs,
//     Concert) et qu'aucun marqueur blacklist n'est présent (Visites,
//     Rencontre, Kids/Teens, Atelier).
//  3. Détail : pour chaque page programme distincte, on visite une seule
//     fois pour récupérer compositeur (souvent en sous-titre du h1),
//     distribution principale (Direction musicale, Mise en scène, rôles)
//     et fourchette de prix. La date / l'heure proviennent de la liste —
//     une page programme regroupe toutes les représentations.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.lamonnaiedemunt.be';
const LIST_PATH = '/fr/calendar';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Catégories à garder : on accepte si le label contient l'un de ces marqueurs.
const KEEP_PATTERNS = [
  /op[eé]ra/i,
  /symphon/i,
  /musique de chambre/i,
  /r[eé]cital/i,
  /\bsongs?\b/i,
  /concert/i,
];

// Catégories à exclure : prennent le pas sur la liste précédente. Les
// événements pédagogiques, visites et tables rondes sont filtrés ici.
const REJECT_PATTERNS = [
  /visite/i,
  /rencontre/i,
  /kids/i,
  /teens/i,
  /atelier/i,
  /quiz/i,
  /soir[eé]es young/i,
  /drag/i,
];

// Le titre ou l'URL peut révéler un méta-événement (Soirée Young Opera =
// pack jeune public attaché à une représentation existante, doublon donc).
// On exclut ces slugs même si la catégorie contient "Opéra".
const TITLE_REJECT_PATTERNS = [
  /soir[eé]es?\s+young/i,
  /visites?\s+guid/i,
  /drag\s+queen/i,
  /opera\s+quiz/i,
  /inside\s+the\s+music/i,
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
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html, { monthStr }) {
  const $ = cheerio.load(html);
  const items = [];

  $('ul.list-table > li.list-item').each((_, el) => {
    const $el = $(el);

    // Date depuis id="day_YYYYMMDD" — pas tous les <li> en ont (ex. multi
    // représentations le même jour : seul le premier porte l'ancre). Dans
    // ce cas on se rabat sur le mois courant + le n° du jour visible.
    let date = null;
    const id = $el.attr('id') || '';
    const m = id.match(/day_(\d{4})(\d{2})(\d{2})/);
    if (m) {
      date = `${m[1]}-${m[2]}-${m[3]}`;
    } else {
      // Fallback : "mardi 12" → on combine avec monthStr (YYYY-MM)
      const dayText = $el.find('.th h3 a, .th h3').first().text().trim();
      const dm = dayText.match(/(\d{1,2})/);
      if (dm && monthStr) date = `${monthStr}-${String(dm[1]).padStart(2, '0')}`;
    }

    const time = ($el.find('.td-hour p').first().text().trim() || null);
    const title = $el.find('.small-title').first().text().trim();
    const category = $el.find('.td-shrink p').first().text().trim().replace(/\s+/g, ' ');
    const url = $el.find('.th h3 a').first().attr('href') || $el.find('a.cta').first().attr('href');
    const isPast = $el.hasClass('list-item-past');
    const cancelled = /complet/i.test($el.find('.cta').text()) ? false : false; // sold out ≠ cancelled

    if (!url || !title || !date) return;
    items.push({
      url: url.startsWith('http') ? url : BASE_URL + url,
      title,
      category,
      date,
      time,
      isPast,
      cancelled,
    });
  });

  return items;
}

function isClassical({ category, title, url }) {
  if (!category) return false;
  // Exclusion par titre/slug (méta-événements, visites, quiz…)
  if (title && TITLE_REJECT_PATTERNS.some((re) => re.test(title))) return false;
  if (url && TITLE_REJECT_PATTERNS.some((re) => re.test(url))) return false;
  if (REJECT_PATTERNS.some((re) => re.test(category))) {
    // "Opéra / Événement" doit rester accepté → on re-vérifie si un keep
    // pattern fort (Opéra/Symphon/Musique de chambre/Récital/Songs) match.
    const strongKeep = [/op[eé]ra/i, /symphon/i, /musique de chambre/i, /r[eé]cital/i, /\bsongs?\b/i];
    if (strongKeep.some((re) => re.test(category))) return true;
    return false;
  }
  // Concert seul est trop large : on n'accepte que si pas de pattern reject.
  return KEEP_PATTERNS.some((re) => re.test(category));
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseDetailPage(html, composerIndex) {
  const $ = cheerio.load(html);

  // Title : le h1 contient un .prod-title avec un span principal et un span
  // plus petit (souvent le compositeur) — on récupère les deux séparément.
  const $h1 = $('header h1, .outer .inner h1').first();
  const $prodTitle = $h1.find('.prod-title').first();
  const titleSpans = $prodTitle.find('span > span').toArray()
    .map((s) => $(s).text().trim())
    .filter(Boolean);
  let mainTitle = titleSpans[0] || $prodTitle.text().trim().replace(/\s+/g, ' ');
  let composerHint = titleSpans.slice(1).join(' ');
  const subtitle = $h1.find('.prod-subtitle').first().text().trim().replace(/\s+/g, ' ');

  // Composers : on prend l'indice composeurs sur le titre + le sous-titre +
  // le composerHint (span petit du h1 qui est typiquement le compositeur).
  const composerBlob = [composerHint, mainTitle, subtitle].filter(Boolean).join(' ');
  let composers = matchComposers(composerBlob, composerIndex);
  if (composers.length === 0 && composerHint) {
    // Repli : le span petit était bien un compositeur mais n'est pas dans
    // l'index — on l'ajoute brut, en title-case approximatif.
    composers = [composerHint.replace(/\s+/g, ' ').trim()];
  }

  // Performers : bloc "Distribution". On extrait les couples
  // role-label / names en limitant aux rôles principaux pour ne pas
  // diluer la liste avec les techniciens et le chœur.
  const PRIMARY_ROLES = /^(direction musicale|chef|conductor|mise en sc[eè]ne|director|piano|violon|orchestre|ch[oœ]urs?|soprano|m[eé]zzo|t[eé]nor|baryton|basse|alto)/i;
  const performers = [];
  $('#distribution, [id="distribution"]').each((_, el) => {});
  // Le bloc Distribution est du <p><span class="role-label">…</span><span class="names">…</span></p>
  $('.credits .role-label').each((_, el) => {
    const $label = $(el);
    const role = $label.text().trim();
    const $names = $label.next('.names');
    const name = $names.text().trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (PRIMARY_ROLES.test(role) || /role|r[oô]le/i.test(role)) {
      performers.push(`${toTitleCase(name)} (${role})`);
    }
  });
  // Si vraiment rien, on garde au moins les deux premières paires (le plus
  // souvent direction musicale + mise en scène).
  if (performers.length === 0) {
    $('.credits .role-label').slice(0, 2).each((_, el) => {
      const $label = $(el);
      const role = $label.text().trim();
      const name = $label.next('.names').text().trim().replace(/\s+/g, ' ');
      if (name) performers.push(`${toTitleCase(name)} (${role})`);
    });
  }

  // Tarifs : bloc .aside.infos contient des phrases du type
  // "Prix de base entre 12 € à 170 €" ou "10 / 25 / 50 €".
  const asideText = $('.aside.infos').text().replace(/\s+/g, ' ');
  let priceMin = null;
  let priceMax = null;
  // 1) Format "entre X € à Y €" / "entre X € et Y €"
  const range = asideText.match(/entre\s+(\d+)\s*€\s*(?:à|et|–|-)\s*(\d+)\s*€/i);
  if (range) {
    priceMin = parseInt(range[1], 10);
    priceMax = parseInt(range[2], 10);
  } else {
    // 2) Repli : tous les nombres suivis de € dans la zone Tarifs (juste
    //    après le h6 icon-rates) — on prend min/max.
    const ratesIdx = asideText.toLowerCase().indexOf('tarif');
    if (ratesIdx >= 0) {
      const ratesZone = asideText.slice(ratesIdx, ratesIdx + 400);
      const nums = (ratesZone.match(/\d+/g) || []).map((n) => parseInt(n, 10)).filter((n) => n >= 5 && n <= 500);
      if (nums.length) {
        priceMin = Math.min(...nums);
        priceMax = Math.max(...nums);
      }
    }
  }

  // Programme texte : on combine sous-titre h1 et le bloc présentation
  // (1ère phrase) si le sous-titre est vide.
  let program = subtitle || null;
  if (!program) {
    const punchline = $('.punchline h2').first().text().trim().replace(/\s+/g, ' ');
    if (punchline) program = punchline;
  }

  return { title: mainTitle, subtitle, composers, performers, program, priceMin, priceMax };
}

function toTitleCase(s) {
  return s
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => /^\s+$|-/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function monthRange(months) {
  const out = [];
  const now = new Date();
  for (let i = 0; i <= months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    out.push(`${y}-${m}`);
  }
  return out;
}

function buildId(date, url, time) {
  const slug = (url.match(/\/program\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `monnaie-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeMonnaie({
  monthsAhead = 14,
  detailDelay = 350,
  monthDelay = 250,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const months = monthRange(monthsAhead);
  let listed = [];
  for (const monthStr of months) {
    const url = `${BASE_URL}${LIST_PATH}?m=${monthStr}`;
    try {
      console.error(`[monnaie] list ${monthStr}`);
      const html = await fetchHtml(url);
      const items = parseListPage(html, { monthStr });
      listed.push(...items);
    } catch (err) {
      console.error(`[monnaie] list ${monthStr} failed: ${err.message}`);
    }
    await sleep(monthDelay);
  }

  // Dedupe par (url, date, time) — la même représentation peut apparaître
  // sur le mois où elle a lieu et nulle part ailleurs en principe, mais on
  // sécurise.
  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // On exclut les dates passées et les categories non retenues.
  const upcoming = listed.filter((it) => !it.isPast && it.date >= today);
  const classical = upcoming.filter((it) => isClassical(it));
  console.error(`[monnaie] ${listed.length} listés / ${upcoming.length} à venir / ${classical.length} retenus`);

  // Détail : une page programme regroupe N représentations — on cache.
  const detailCache = new Map();
  const concerts = [];
  for (const item of classical) {
    let detail = detailCache.get(item.url);
    if (!detail) {
      try {
        const html = await fetchHtml(item.url);
        detail = parseDetailPage(html, composerIndex);
        detailCache.set(item.url, detail);
        await sleep(detailDelay);
      } catch (err) {
        console.error(`[monnaie] detail failed for ${item.url}: ${err.message}`);
        detail = null;
      }
    }

    concerts.push({
      id: buildId(item.date, item.url, item.time),
      source: 'monnaie',
      venue_id: 'lamonnaie',
      title: detail?.title || item.title,
      date: item.date,
      time: item.time,
      url: item.url,
      composers: detail?.composers || [],
      performers: detail?.performers || [],
      program: detail?.program || item.title,
      price_min: detail?.priceMin ?? null,
      price_max: detail?.priceMax ?? null,
      scraped_at: new Date().toISOString(),
    });
  }

  console.error(`[monnaie] ${concerts.length} concerts produits`);
  return concerts;
}

// CLI direct execution: print JSON to stdout (logs go to stderr)
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeMonnaie()
    .then((concerts) => {
      process.stdout.write(JSON.stringify(concerts, null, 2) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
