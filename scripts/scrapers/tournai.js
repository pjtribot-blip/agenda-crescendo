// Scraper Maison de la Culture de Tournai (REFONTE Phase 3.5bis)
//
// La MdC est pluridisciplinaire. La discipline Drupal "musique" est trop
// large : elle inclut chanson française (Brel, Piaf, Biolay), pop
// (Yael Naim, Zap Mama), rap (MC Solaar, Youssef Swatt's), DJ sets
// "Pitch & Play vinyles", apéros, soirées thématiques. Filtre par
// blacklist seule (Phase 2.9) → 0 concert capté (trop conservateur).
//
// Stratégie refonte : **whitelist par mots-clés savants** sur
// title + artistes. On garde si l'un des deux contient un terme
// classique/baroque/lyrique/chambre/co-réalisation Chapelle ou
// Voix Intimes. Pas de filtre discipline préalable (certains
// concerts savants sont taggés "spectacles" — Carmen. de Gremaud
// par exemple).
//
// Pour les co-réalisations Voix Intimes / Festival Contrastes :
// le tagging festival sera appliqué automatiquement par
// applyFestivalTags (festivals.json) sur la fenêtre de dates.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://maisonculturetournai.com';
const LIST_PATH = '/programme';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Whitelist — au moins un de ces motifs doit matcher (title OU artistes).
// Ordre : du plus spécifique au plus générique.
const SAVANT_KEYWORDS = [
  // Ensembles & formations
  /quatuor|quartet/i,
  /ch[oœ]ur de chambre|choeur de chambre/i,
  /chorale/i,
  /orchestre|orchestra/i,
  /ensemble.{0,30}(?:baroque|classique|musique ancienne)/i,
  /chapelle musicale/i,
  /candide orchestra/i,
  /proquartetto|voix intimes|ardeo/i,
  // Genres savants
  /\bclassique\b|musique classique/i,
  /\bbaroque\b/i,
  /musique ancienne|early music/i,
  /\blyrique\b|gala lyrique/i,
  /\bop[eé]ra\b/i,
  /musique de chambre|chamber music/i,
  /\br[eé]cital\b/i,
  // Formes
  /\bsonate\b|\bsonata\b/i,
  /\bconcerto\b|\bconcertino\b/i,
  /\bsymphonie\b|symphony/i,
  /\bcantate\b|\bcantata\b/i,
  /\boratorio\b|passion (?:selon|de)/i,
  /lied(?:er)?\b|m[eé]lodies? fran[cç]aise/i,
  // Concours / festivals savants
  /concours international|prix.{0,15}piano/i,
  /festival musical(?: du| de)? hainaut/i,
];

// Hard reject — quel que soit le contexte, on rejette.
// Capture les motifs chanson/pop/jazz/rap/électro/DJ qui pourraient
// par erreur déclencher un keyword savant (ex. "Concertino" dans un
// titre de DJ set hypothétique).
const TITLE_REJECT_PATTERNS = [
  /afterwork/i,
  /\bpitch\s*[&et]\s*play\b/i,
  /\bvinyles?\b/i,
  /\bdj\s+set\b/i,
  /le bar part en live/i,
  /\byael naim\b|yaël naim/i,
  /\bzap mama\b/i,
  /\bmc solaar\b/i,
  /\byoussef swatt/i,
  /\bsalvatore adamo\b/i,
  /\bbrel\b.*spectacle|brel.{0,15}le spectacle/i,
  /\bpiaf\b.*spectacle/i,
  /\bbenjamin biolay\b/i,
  /\banne roumanoff\b/i,
  /\belie semoun\b|cactus.{0,15}elie/i,
  /\bra[uú]l paz\b/i,
  /\bsam sauvage\b/i,
  /tournai jazz festival/i,
  /soir[eé]e\s+pitch/i,
  /\brap\b|hip[-\s]?hop/i,
  /\brock\b|\bpunk\b|\bmetal\b/i,
  /\bsoul\b|\bfunk\b|\bblues\b/i,
  /\bworld\b|musique du monde/i,
  /\bcabaret\b/i, // cabaret variétés / sans contexte savant
  /\bvari[eé]t[eé]s?\b/i,
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
          'Accept-Language': 'fr-BE,fr;q=0.9',
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

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014',
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
// List page parsing
// ------------------------------------------------------------------
function parseListPage(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('.view-programme .views-row').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('a[href^="/programme/"]').first();
    const href = $a.attr('href') || '';
    if (!href) return;
    const url = href.startsWith('http') ? href : BASE_URL + href;

    const title = decodeEntities($el.find('.title, h3.title, h3').first().text().trim()).replace(/\s+/g, ' ');
    const artistes = decodeEntities($el.find('.field--name-field-artistes .field__item, .field--name-field-artistes').first().text().trim()).replace(/\s+/g, ' ');
    const dateText = $el.find('.date').first().text().trim().replace(/\s+/g, ' ');
    // Accepte "DD.MM.YYYY" et "DD—DD.MM.YYYY" (range : on prend le 1er)
    const dm = dateText.match(/(\d{1,2})(?:[—–-]\d{1,2})?\.(\d{1,2})\.(\d{4})/);
    if (!dm) return;
    const date = `${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`;

    const disciplines = $el.find('.field--name-field-discipline .field__item').toArray()
      .map((d) => normalize($(d).text()));
    const lieu = $el.find('.field--name-field-lieu .field__item').first().text().trim();

    items.push({ url, title, artistes, date, disciplines, lieu });
  });

  return items;
}

function matchesSavant(item) {
  const haystack = `${item.title} ${item.artistes}`;
  return SAVANT_KEYWORDS.some((re) => re.test(haystack));
}

function matchesReject(item) {
  return TITLE_REJECT_PATTERNS.some((re) => re.test(item.title));
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url) {
  const slug = (url.match(/\/programme\/([^?#]+)/) || [])[1] || 'event';
  return `tournai-${date}-${slug.replace(/\//g, '-')}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeTournai({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  const url = `${BASE_URL}${LIST_PATH}`;
  console.error(`[tournai] list ${url}`);
  const html = await fetchHtml(url);
  let listed = parseListPage(html);

  // Dédupe (url, date)
  const seen = new Set();
  listed = listed.filter((it) => {
    const k = `${it.url}|${it.date}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const upcoming = listed.filter((it) => it.date >= today);
  const notRejected = upcoming.filter((it) => !matchesReject(it));
  const allowed = notRejected.filter(matchesSavant);
  console.error(`[tournai] ${listed.length} listés / ${upcoming.length} à venir / ${notRejected.length} après reject titre / ${allowed.length} retenus (whitelist savant)`);

  const concerts = allowed.map((it) => {
    const composers = matchComposers(`${it.title} ${it.artistes}`, composerIndex);
    const programParts = [];
    if (it.artistes) programParts.push(it.artistes);
    if (it.lieu) programParts.push(it.lieu);
    return {
      id: buildId(it.date, it.url),
      source: 'tournai',
      venue_id: 'mctournai',
      title: it.title,
      date: it.date,
      time: null,
      url: it.url,
      composers,
      performers: [],
      program: programParts.length ? programParts.join(' — ') : null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    };
  });

  console.error(`[tournai] ${concerts.length} concerts produits`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeTournai()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
