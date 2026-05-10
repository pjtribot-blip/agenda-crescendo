// Scraper Flagey — agenda classique / contemporain / résidences orchestrales
//
// Stratégie :
//  1. Liste : on itère sur /fr/agenda?ym=YYYY-MM du mois courant à +14 mois.
//     Chaque <li class="agenda__activity"> est une représentation datée
//     (le jour est porté par le <li class="agenda__day"> parent ; l'heure
//     par <span class="item__dates">). Les jours marqués "inactive"
//     appartiennent au mois voisin et seront couverts par leur propre
//     mois — on les ignore pour ne pas dupliquer.
//  2. Pré-filtre : on ne garde que les activités taggées "Music" dans la
//     liste (le tag agenda ne donne pas le sous-genre). Cela écarte d'office
//     Cinema, Junior cinema et Festivals non musicaux.
//  3. Détail : pour chaque URL distincte, on charge la page d'activité une
//     seule fois pour récupérer les tags fins (Classique, Contemporain,
//     Jazz, Global, Electronique, Orchestre, Piano, Quatuor à cordes,
//     Chant, Musique-images…), le sous-titre, le bloc "credits" et le
//     bloc texte. Filtre éditorial sur ces tags : on garde si au moins un
//     tag "savant" est présent ; on rejette si seuls Jazz/Global/
//     Electronique sont présents. Cas ambigu (Music sans tag de genre) :
//     on garde par défaut et on log dans stderr.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.flagey.be';
const LIST_PATH = '/fr/agenda';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Tags qui indiquent un répertoire savant — la présence d'un seul suffit.
// Les tags arrivent en lower-case + trim, espaces → '-' (slug-style).
const KEEP_TAGS = new Set([
  'classique',
  'contemporain',
  'orchestre',
  'piano',
  'quatuor-a-cordes',
  'chant',
  'musique-images',
  'musique-de-chambre',
  'musique-ancienne',
  'baroque',
  'recital',
  'lied',
  'opera',
]);

// Tags qui, seuls, font rejeter (typiquement musiques actuelles ou
// événements non musicaux). Si l'événement cumule un de ces tags ET un
// KEEP_TAGS, on garde (cas crossover : récital classique programmé dans
// un festival Jazz).
const REJECT_TAGS = new Set([
  'electronique',
  'global',
  'jazz',
  'cinema',
  'comedy',
  'comedie',
  'dance',
  'danse',
  'theatre',
  'theater',
  'expo',
  'exposition',
]);

// Tags qui rejettent même si un KEEP_TAGS est présent (ex. concert
// classique pour enfants : on filtre car hors public éditorial).
const HARD_REJECT_TAGS = new Set([
  'junior',
  'concert-en-famille',
  'jeune-public',
]);

// Patterns sur le titre/URL qui rejettent même si les tags sont OK
// (cas typique : sound installation taggée Contemporain mais qui n'est
// pas un concert).
const TITLE_REJECT_PATTERNS = [
  /sound\s+installation/i,
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

function tagSlug(s) {
  return normalize(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ------------------------------------------------------------------
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html, { monthStr }) {
  const $ = cheerio.load(html);
  const items = [];

  // Chaque jour : <li class="item agenda__day"> (parfois "inactive" pour
  // les jours de débordement avant/après le mois courant).
  $('li.agenda__day').each((_, dayEl) => {
    const $day = $(dayEl);
    if ($day.hasClass('inactive')) return;
    const dayNum = parseInt($day.find('.day__number').first().text().trim(), 10);
    if (!Number.isFinite(dayNum)) return;
    const date = `${monthStr}-${String(dayNum).padStart(2, '0')}`;

    $day.find('li.agenda__activity').each((_, actEl) => {
      const $act = $(actEl);
      const href = $act.find('a.item__link').first().attr('href');
      if (!href) return;
      const url = href.startsWith('http') ? href : BASE_URL + href;
      const title = $act.find('.item__title').first().text().trim().replace(/\s+/g, ' ');
      const time = $act.find('.item__dates').first().text().trim() || null;
      const tagsText = $act.find('.tags').first().text().trim();
      const tags = tagsText
        .split(',')
        .map((t) => tagSlug(t))
        .filter(Boolean);
      items.push({ url, title, date, time, listTags: tags });
    });
  });

  return items;
}

function isMusicActivity(item) {
  return item.listTags.includes('music');
}

// Décide en fonction des tags fins de la page détail (et du titre).
// Retour : 'keep' | 'reject' | 'ambiguous' (ambigu = pas de tag de genre)
function classify(detailTags, title) {
  const set = new Set(detailTags);
  if ([...HARD_REJECT_TAGS].some((t) => set.has(t))) return 'reject';
  if (title && TITLE_REJECT_PATTERNS.some((re) => re.test(title))) return 'reject';
  const hasKeep = [...KEEP_TAGS].some((t) => set.has(t));
  const hasReject = [...REJECT_TAGS].some((t) => set.has(t));
  if (hasKeep) return 'keep';
  if (hasReject) return 'reject';
  return 'ambiguous';
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseDetailPage(html, composerIndex) {
  const $ = cheerio.load(html);

  const title = $('h1.header__title').first().text().trim().replace(/\s+/g, ' ');
  const subtitle = $('h2.header__subtitle').first().text().trim().replace(/\s+/g, ' ');
  const tags = $('header.header .tags a').toArray()
    .map((a) => tagSlug($(a).text()))
    .filter(Boolean);

  // Prix : "€ 14 > € 11" ou "€ 25 > € 8"
  const priceText = $('.infos__price').first().text().replace(/\s+/g, ' ').trim();
  let priceMin = null;
  let priceMax = null;
  const nums = (priceText.match(/\d+/g) || []).map((n) => parseInt(n, 10));
  if (nums.length) {
    priceMin = Math.min(...nums);
    priceMax = Math.max(...nums);
  }

  // Salle (studio 1, studio 4…)
  const room = $('.infos__venue').first().text().replace(/\s+/g, ' ').trim() || null;

  // Hosted = co-production externe (Concours Reine Elisabeth, ARS Musica…)
  const hosted = $('aside.aside--hosted').length > 0;

  // Texte présentation : on prend la première phrase, utile pour la
  // recherche de compositeurs et pour le champ program.
  const mainText = $('.main-text .text').first().text().replace(/\s+/g, ' ').trim();
  const credits = $('aside.aside--credits').first().text().replace(/\s+/g, ' ').trim();

  // Compositeurs : matching sur title + subtitle + premier paragraphe.
  const composerBlob = [title, subtitle, mainText.slice(0, 1500)].filter(Boolean).join(' ');
  const composers = matchComposers(composerBlob, composerIndex);

  // Programme : sous-titre s'il existe, sinon début du texte.
  let program = subtitle || null;
  if (!program && mainText) {
    program = mainText.split(/[.!?]\s/)[0].slice(0, 220);
  }

  return { title, subtitle, tags, priceMin, priceMax, room, hosted, composers, program, credits };
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

function buildId(date, url) {
  const slug = (url.match(/\/activity\/([^/?#]+)/) || [])[1] || 'event';
  return `flagey-${date}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeFlagey({
  monthsAhead = 14,
  detailDelay = 350,
  monthDelay = 250,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // 1. Liste mois par mois
  let listed = [];
  for (const monthStr of monthRange(monthsAhead)) {
    const url = `${BASE_URL}${LIST_PATH}?ym=${monthStr}`;
    try {
      console.error(`[flagey] list ${monthStr}`);
      const html = await fetchHtml(url);
      const items = parseListPage(html, { monthStr });
      listed.push(...items);
    } catch (err) {
      console.error(`[flagey] list ${monthStr} failed: ${err.message}`);
    }
    await sleep(monthDelay);
  }

  // Dédupe (url, date, time) — une activité multi-jour est listée par jour
  const seen = new Set();
  listed = listed.filter((it) => {
    const key = `${it.url}|${it.date}|${it.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 2. Pré-filtre : Music + dates futures
  const upcoming = listed.filter((it) => !it.date || it.date >= today);
  const music = upcoming.filter(isMusicActivity);
  console.error(`[flagey] ${listed.length} listés / ${upcoming.length} à venir / ${music.length} taggés Music`);

  // 3. Détail (cache par URL) + classification
  const detailCache = new Map();
  const decisionByUrl = new Map();
  const ambiguous = [];
  const concerts = [];

  for (const item of music) {
    let detail = detailCache.get(item.url);
    if (!detail) {
      try {
        const html = await fetchHtml(item.url);
        detail = parseDetailPage(html, composerIndex);
        detailCache.set(item.url, detail);
        await sleep(detailDelay);
      } catch (err) {
        console.error(`[flagey] detail failed for ${item.url}: ${err.message}`);
        detail = null;
      }
    }
    if (!detail) continue;

    let decision = decisionByUrl.get(item.url);
    if (!decision) {
      decision = classify(detail.tags, detail.title || item.title);
      decisionByUrl.set(item.url, decision);
      if (decision === 'ambiguous') {
        ambiguous.push({ url: item.url, title: detail.title, tags: detail.tags });
      }
    }
    if (decision === 'reject') continue;
    // ambigu : on garde par défaut (cf consigne)

    concerts.push({
      id: buildId(item.date, item.url),
      source: 'flagey',
      venue_id: 'flagey',
      title: detail.title || item.title,
      date: item.date,
      time: item.time,
      url: item.url,
      composers: detail.composers || [],
      performers: [], // Flagey n'a pas de bloc distribution structuré sur la page agenda
      program: detail.program || item.title,
      price_min: detail.priceMin ?? null,
      price_max: detail.priceMax ?? null,
      scraped_at: new Date().toISOString(),
    });
  }

  console.error(`[flagey] ${concerts.length} concerts produits`);
  if (ambiguous.length) {
    console.error(`[flagey] ${ambiguous.length} ambigus (gardés par défaut, pas de tag de genre) :`);
    for (const a of ambiguous) console.error(`  - ${a.title} — tags=[${a.tags.join(', ')}] — ${a.url}`);
  }
  return concerts;
}

// CLI direct execution: print JSON to stdout (logs go to stderr)
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeFlagey()
    .then((concerts) => {
      process.stdout.write(JSON.stringify(concerts, null, 2) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
