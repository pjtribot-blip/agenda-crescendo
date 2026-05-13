// Scraper Opéra de Lille — refonte Phase 3.20
//
// La saison 26-27 a apporté deux changements bloquants sur le site :
//   1. /saison-26-27/ redirige vers une JPEG (le flyer Saison-26-27.jpg)
//      au lieu d'une page HTML exploitable. Donc impossible de découvrir
//      les productions par scan de la page saison comme avant.
//   2. Les fiches /spectacle/{slug}/ ne contiennent plus les dates dans
//      les conteneurs `calendrier-YYYY-MM-DD` (qui existent toujours mais
//      affichent maintenant un calendrier global du lieu pointant vers
//      d'autres productions). Le nouveau format des dates est :
//        <div class="spectacle-details-horaires">
//          <p>
//            <span class="spectacle-details-date">Lundi 10 mai 2027</span>
//            <span class="spectacle-details-heure">20h</span>
//            <span class="spectacle-details-statut">À venir</span>
//          </p>
//          ...
//        </div>
//
// Nouvelle stratégie :
//   1. Source de la liste : home page / qui contient ~36 liens
//      /spectacle/{slug}/ couvrant les saisons en cours. On dédupe par
//      slug et on visite chaque fiche.
//   2. Catégorie : extraite de <p class="sHeader_cat"><span> sur la
//      fiche détail. Filtre KEEP/REJECT cohérent avec l'ancien scraper.
//      Nouveauté : on rejette "hors-les-murs" car ces productions sont
//      jouées chez d'autres (Opera d'Anvers, Concertgebouw Bruges) déjà
//      captées par les sources OBV / cgbrugge.
//   3. Dates : parsing du nouveau bloc .spectacle-details-horaires p
//      avec ses 3 spans (date FR « Lundi 10 mai 2027 » → ISO, heure
//      « 20h » → « 20:00 », statut « À venir » / « Complet » / « Annulé »).
//
// Test attendu Phase 3.20 :
//   - Otello (9 dates 10/05 → 03/06/2027)
//   - Ermonela – L'âme en feu (2 dates 3 + 6/12/2026)
// → après refonte, ces 11 dates remontent côté opl. La phase ONL
//   Phase 3.19 conserve ces productions avec marqueur co-production —
//   le dédoublonnage cross-source (Phase 3.12+) supersède la version
//   ONL par celle d'opl quand venue_id et (date, time) matchent.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.opera-lille.fr';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// On découvre les productions via la home (~36 liens /spectacle/) et
// /programmation/ (~8 liens, productions actives).
const DISCOVERY_PATHS = ['/', '/programmation/'];

// Catégories autorisées (texte exact du span sHeader_catItem, en
// minuscules après normalize).
const KEEP_CATEGORIES = new Set([
  'opera', 'opera itinerant',
  'concert',
  'ballet', 'ballet symphonique',
  'recital', 'recital lyrique',
  'evenement',
  'sieste', 'heure bleue', 'insomniaque',
]);

// Catégories rejetées : ateliers, conférences, soirées BAL, visites,
// open week, danse pure, performances plasticiennes, jeune public
// non-musical, hors-les-murs (déjà capté ailleurs).
const REJECT_CATEGORIES = new Set([
  'open week',
  'danse', 'danse-theatre',
  'performance',
  'avec vous !',
  'famille', 'en famille',  // (jeune public — souvent non-musical OPL,
                            //  les concerts musicaux famille restent
                            //  via les venues partenaires)
  'hors-les-murs', 'hors les murs',
  'atelier',
  'visite',
  'conference', 'rencontre',
  'bal',
  'sortie',
]);

const MONTHS_FR = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  février: 2, août: 8, décembre: 12,
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
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014', eacute: 'é', egrave: 'è',
  ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô',
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
// Discovery : récupère tous les slugs /spectacle/{slug}/ sur les
// pages de découverte.
// ------------------------------------------------------------------
async function discoverProductionUrls() {
  const urls = new Set();
  for (const path of DISCOVERY_PATHS) {
    let html;
    try { html = await fetchHtml(`${BASE_URL}${path}`); }
    catch (err) {
      console.error(`[opl] découverte ${path} échec : ${err.message}`);
      continue;
    }
    if (!html) continue;
    const $ = cheerio.load(html);
    $('a[href*="/spectacle/"]').each((_, a) => {
      let href = $(a).attr('href') || '';
      if (!href) return;
      if (!href.startsWith('http')) href = BASE_URL + href;
      // Normalise trailing slash
      if (!href.endsWith('/')) href += '/';
      // Garde uniquement /spectacle/{slug}/
      if (/\/spectacle\/[^/]+\/$/.test(href)) urls.add(href);
    });
    await sleep(180);
  }
  return [...urls];
}

// ------------------------------------------------------------------
// Detail parsing
// ------------------------------------------------------------------
// "Lundi 10 mai 2027" → "2027-05-10".
// Si l'année est absente (cas Ermonela : « Jeudi 3 décembre »), on
// utilise fallbackYear (récupéré depuis .sHeader_infos ou la date du
// premier item du bloc qui aurait une année).
function parseFrDate(s, fallbackYear = null) {
  if (!s) return null;
  // Format avec année explicite
  let m = s.match(/(\d{1,2})\s+([a-zéûô]+)\s+(\d{4})/i);
  if (m) {
    const month = MONTHS_FR[normalize(m[2])];
    if (!month) return null;
    return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  // Format sans année — on injecte fallbackYear
  if (!fallbackYear) return null;
  m = s.match(/(\d{1,2})\s+([a-zéûô]+)/i);
  if (!m) return null;
  const month = MONTHS_FR[normalize(m[2])];
  if (!month) return null;
  return `${fallbackYear}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// "20h" → "20:00", "16h30" → "16:30"
function parseFrTime(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\s*h\s*(\d{0,2})/i);
  if (!m) return null;
  const hh = m[1].padStart(2, '0');
  const mm = (m[2] || '00').padStart(2, '0');
  return `${hh}:${mm}`;
}

function parseDetail(html) {
  const $ = cheerio.load(html);
  const cat = normalize($('p.sHeader_cat .sHeader_catItem').first().text());
  const title = decodeEntities($('h1.sHeader_title').first().text().trim()).replace(/\s+/g, ' ');
  const infos = decodeEntities($('p.sHeader_infos').first().text().trim()).replace(/\s+/g, ' ');

  // Année fallback : on cherche la 1re année 4 chiffres dans infos
  // (ex. "3 et 6 décembre 2026"). Si absente, currentYear par défaut.
  let fallbackYear = null;
  const ym = infos.match(/\b(20\d{2})\b/);
  if (ym) fallbackYear = ym[1];
  else fallbackYear = String(new Date().getFullYear());

  const dates = [];
  $('.spectacle-details-horaires p').each((_, p) => {
    const $p = $(p);
    const dateText = $p.find('.spectacle-details-date').first().text().trim();
    const timeText = $p.find('.spectacle-details-heure').first().text().trim();
    const statut = decodeEntities($p.find('.spectacle-details-statut').first().text().trim()).toLowerCase();
    const date = parseFrDate(dateText, fallbackYear);
    const time = parseFrTime(timeText);
    if (!date) return;
    // statut = "à venir" / "complet" / "annulé" — on rejette annulés
    if (/annul/i.test(statut)) return;
    dates.push({ date, time, statut });
  });

  return { cat, title, infos, dates };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, url, time) {
  const slug = (url.match(/\/spectacle\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `opl-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeOperaLille({
  detailDelay = 250,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  console.error(`[opl] découverte via ${DISCOVERY_PATHS.join(' + ')}`);
  const urls = await discoverProductionUrls();
  console.error(`[opl] ${urls.length} productions distinctes`);

  const concerts = [];
  let rejectedCat = 0, noDate = 0, allPast = 0;
  for (const url of urls) {
    let html;
    try { html = await fetchHtml(url); }
    catch (err) {
      console.error(`[opl]   détail ${url} échec : ${err.message}`);
      continue;
    }
    if (!html) continue;
    const d = parseDetail(html);

    if (REJECT_CATEGORIES.has(d.cat)) { rejectedCat++; continue; }
    if (d.cat && !KEEP_CATEGORIES.has(d.cat)) {
      // Catégorie inconnue : on signale + on garde par défaut (Opéra de
      // Lille programme rarement hors-musical).
      console.error(`[opl]   cat inconnue "${d.cat}" → keep par défaut (${url.match(/\/spectacle\/([^/]+)/)[1]})`);
    }

    if (!d.dates.length) { noDate++; continue; }
    const futureDates = d.dates.filter((x) => x.date >= today);
    if (!futureDates.length) { allPast++; continue; }

    const composers = matchComposers(`${d.title} ${d.infos}`, composerIndex);
    for (const { date, time, statut } of futureDates) {
      concerts.push({
        id: buildId(date, url, time),
        source: 'opl',
        venue_id: 'operalille',
        title: d.title,
        date,
        time,
        url,
        composers,
        performers: [],
        program: [d.infos, statut !== 'à venir' && statut ? statut : null].filter(Boolean).join(' — ') || null,
        price_min: null,
        price_max: null,
        scraped_at: new Date().toISOString(),
      });
    }
    await sleep(detailDelay);
  }

  console.error(`[opl] ${concerts.length} concerts produits | rejet catégorie ${rejectedCat} | sans dates ${noDate} | dates passées ${allPast}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeOperaLille()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
