// Scraper MARS — Mons Arts de la Scène
//
// MARS est pluridisciplinaire (musique, théâtre, danse, cirque, littérature).
// Stratégie :
//  1. Liste : on itère sur /calendrier/YYYYMM mois par mois (la pagination
//     suit ce schéma). Chaque <div class="teaser-date-event--calendars">
//     est une occurrence avec un <time datetime> structuré et un lien
//     /agenda/YYYY-MM/CATEGORY/SLUG.
//  2. Filtre éditorial : on garde UNIQUEMENT les liens dont le segment
//     catégorie de l'URL est "musique" (Drupal taxonomy côté MARS). Cela
//     écarte d'office théâtre, danse, cirque, littérature, rendez-vous.
//  3. Sous-filtre titre : MARS programme aussi du jazz, du slam, des
//     musiques actuelles dans la rubrique "musique". On rejette par titre
//     les motifs clairement non savants (jazz fusion, slam, festival
//     pop, soirées électro). En cas de doute → on garde et on signale.
//  4. Détail : pas de structure programme/distribution structurée
//     fiable côté MARS. On utilise titre + extrait pour le matching de
//     compositeurs.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://surmars.be';
const LIST_PATH = '/calendrier';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Sous-genres MARS visibles sur la page détail (en plus du tag conteneur
// "Musique" qui est commun à toute la rubrique). On garde si un de ces
// sous-genres est présent.
const KEEP_SUBTAGS = new Set([
  'classique',
  'musique d aujourd hui',
  'musique ancienne',
  'baroque',
  'opera',
  'opera buffa',
  'recital',
  'lied',
  'ancien',
  'lyrique',
]);

// Sous-genres exclus : si on n'a aucun KEEP_SUBTAG, ces tags suffisent à
// rejeter sans ambiguïté.
const REJECT_SUBTAGS = new Set([
  'rock', 'pop', 'electro', 'electronique', 'techno', 'house',
  'jazz', 'blues', 'soul', 'funk', 'reggae', 'hip hop', 'rap',
  'chanson francaise', 'chanson', 'world', 'folk', 'traditionnel',
  'metal', 'punk', 'slam',
]);

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
      if (res.status === 404) return null; // mois sans contenu
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
// List page parsing
// ------------------------------------------------------------------
function parseCalendarPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('.teaser-date-event--calendars').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a[href^="/agenda/"]').first();
    const href = $a.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;

    // Catégorie depuis l'URL : /agenda/YYYY-MM/CATEGORY/SLUG
    const catMatch = href.match(/^\/agenda\/\d{4}-\d{2}\/([a-z-]+)\/[a-z0-9-]+/);
    const category = catMatch ? catMatch[1] : null;

    const $time = $el.find('time[datetime]').first();
    const dt = $time.attr('datetime') || '';
    const dm = dt.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!dm) return;
    const date = dm[1];
    const time = dm[2] && dm[3] ? `${dm[2]}:${dm[3]}` : null;

    const title = $el.find('h2').first().text().trim().replace(/\s+/g, ' ');
    if (!title) return;

    items.push({ url, title, date, time, category });
  });

  // Pagination : <a href="/calendrier/YYYYMM" rel="next">
  const $next = $('.pager a[rel="next"]').first();
  const nextHref = $next.attr('href') || '';

  return { items, nextHref };
}

function isAllowedListing(item) {
  // Pré-filtre liste : seulement les liens /agenda/YYYY-MM/musique/…
  return item.category === 'musique';
}

function classifyDetailTags(tags) {
  // Drop les tags conteneurs ("musique", "theatre" affichés systématiquement)
  const meaningful = tags
    .map(normalize)
    .map((t) => t.replace(/[\u2019']/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t && t !== 'musique' && t !== 'theatre' && t !== 'famille  ados' && t !== 'famille / ados');
  const hasKeep = meaningful.some((t) => KEEP_SUBTAGS.has(t));
  if (hasKeep) return 'keep';
  const hasReject = meaningful.some((t) => REJECT_SUBTAGS.has(t));
  if (hasReject) return 'reject';
  return 'ambiguous'; // ni l'un ni l'autre — par prudence, on rejette (cf
  // consigne "filtre éditorial strict" pour MARS)
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseDetailPage(html, composerIndex) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim().replace(/\s+/g, ' ');

  // Sous-genres : tous les .colored-tag > div (peuvent apparaître plusieurs
  // fois — on dédupe).
  const tags = [...new Set($('.colored-tag div').toArray().map((d) => $(d).text().trim()))]
    .filter(Boolean);

  // Description : extraction grossière du body principal (Drupal renvoie
  // un <div> de texte dans la grande zone gauche, sans classe stable).
  const desc = $('p').toArray()
    .map((p) => $(p).text().replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 30)
    .slice(0, 4)
    .join(' ');

  const composers = matchComposers(`${title} ${desc}`.slice(0, 2000), composerIndex);
  return { title, desc, tags, composers };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function ymToYYYYMM(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

function buildId(date, url, time) {
  const slug = (url.match(/\/musique\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `mars-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeMARS({
  monthsAhead = 14,
  detailDelay = 350,
  monthDelay = 250,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // Itère sur YYYYMM du mois courant à +monthsAhead, en suivant aussi
  // rel=next quand disponible (sécurité).
  const now = new Date();
  const months = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push(ymToYYYYMM(d));
  }

  let listed = [];
  for (const ym of months) {
    const url = `${BASE_URL}${LIST_PATH}/${ym}`;
    try {
      console.error(`[mars] list ${ym}`);
      const html = await fetchHtml(url);
      if (!html) continue;
      const { items } = parseCalendarPage(html);
      listed.push(...items);
    } catch (err) {
      console.error(`[mars] list ${ym} failed: ${err.message}`);
    }
    await sleep(monthDelay);
  }

  // Dédupe (url, date, time)
  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  const musique = upcoming.filter(isAllowedListing);
  console.error(`[mars] ${listed.length} listés / ${upcoming.length} à venir / ${musique.length} dans la rubrique musique`);

  // Détail (cache par URL) + classification fine sur les sous-genres
  const detailCache = new Map();
  const decisions = new Map();
  const ambiguous = [];
  const concerts = [];
  for (const item of musique) {
    let detail = detailCache.get(item.url);
    if (!detail) {
      try {
        const html = await fetchHtml(item.url);
        if (html) detail = parseDetailPage(html, composerIndex);
        if (detail) detailCache.set(item.url, detail);
        await sleep(detailDelay);
      } catch (err) {
        console.error(`[mars] detail failed for ${item.url}: ${err.message}`);
        detail = null;
      }
    }
    if (!detail) continue;

    let decision = decisions.get(item.url);
    if (!decision) {
      decision = classifyDetailTags(detail.tags);
      decisions.set(item.url, decision);
      if (decision === 'ambiguous') {
        ambiguous.push({ url: item.url, title: detail.title, tags: detail.tags });
      }
    }
    if (decision !== 'keep') continue;

    concerts.push({
      id: buildId(item.date, item.url, item.time),
      source: 'mars',
      venue_id: 'mars',
      title: detail.title || item.title,
      date: item.date,
      time: item.time,
      url: item.url,
      composers: detail.composers || [],
      performers: [],
      program: detail.desc || null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
  }
  if (ambiguous.length) {
    console.error(`[mars] ${ambiguous.length} événements ambigus (rejetés — pas de tag classique/jazz/etc.) :`);
    for (const a of ambiguous.slice(0, 8)) console.error(`  - ${a.title} — tags=[${a.tags.join(', ')}]`);
  }

  console.error(`[mars] ${concerts.length} concerts produits`);
  return concerts;
}

// CLI direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeMARS()
    .then((concerts) => {
      process.stdout.write(JSON.stringify(concerts, null, 2) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
