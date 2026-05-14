// Scraper Cathedralis Bruxellensis (Cathédrale Saints-Michel-et-Gudule)
//
// Cathédrale de Bruxelles. Site WordPress + plugin MEC (Modern Events
// Calendar). Programmation : récitals d'orgue, concerts choraux,
// musique sacrée baroque/classique, carillons festifs, fanfares
// (Sainte Cécile d'Evere), vêpres liturgiques.
//
// La page archive /mec-category/concerts/ expose 9 concerts à venir
// via 9 blocs JSON-LD `@type: Event`. L'API REST mec-events existe
// (/wp-json/wp/v2/mec-events) mais n'expose pas les dates/heures
// d'événement (que des dates de publication). → on parse le JSON-LD.
//
// Bug du plugin MEC : startDate ISO est décalé de +2h vs le titre
// (probablement double conversion fuseau). On parse l'heure depuis
// le titre quand il la contient (format "DD/MM/YYYY – HH:MM –"),
// fallback sur startDate -2h.
//
// Filtre éditorial :
//   SKIP : carillons festifs, fanfares amateur, vêpres liturgiques,
//          messes solennelles, conférences, interventions pastorales
//   GARDER : récitals d'orgue, concerts choraux, ensembles vocaux/
//            instrumentaux, musique sacrée structurée

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://cathedralisbruxellensis.be';
const LIST_PATH = '/mec-category/concerts/';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Filtres éditoriaux — formats à exclure (carillons, fanfares amateur,
// liturgie pure). Le carillon n'est PAS un concert classique au sens
// éditorial Crescendo : courte forme festive/civique (Te Deum fête
// nationale, Saint-Michel, Fête du Roi…).
const SKIP_TITLE_PATTERNS = [
  /\bcarillon\b/i,
  /\bfanfare\b/i,
  /\bharmonie\s+royale\b/i,
  /\bv[êe]pres?\b/i,
  /\bmesse\s+solennelle\b/i,
  /\bc[ée]l[ée]bration\s+de\s+l[''']appel\b/i,
  /\bsemaine\s+sainte\b/i,
  /\bconf[ée]rence\s+de\s+car[êe]me\b/i,
  /\bintervention\s+pastorale\b/i,
  /\bc[ée]r[ée]monie\s+d[''']adieu\b/i,
  /\bp[âa]ques\b/i,
  /\bsacrement\b/i,
];

// ------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------
async function fetchHtml(url, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'fr-BE,fr;q=0.9' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018').replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D').replace(/&hellip;/g, '\u2026')
    .replace(/&ndash;/g, '\u2013').replace(/&mdash;/g, '\u2014')
    .replace(/&laquo;/g, '\u00AB').replace(/&raquo;/g, '\u00BB')
    .replace(/&eacute;/g, 'é').replace(/&egrave;/g, 'è').replace(/&ecirc;/g, 'ê')
    .replace(/&agrave;/g, 'à').replace(/&acirc;/g, 'â').replace(/&ccedil;/g, 'ç')
    .replace(/&ocirc;/g, 'ô').replace(/&ucirc;/g, 'û');
}

// ------------------------------------------------------------------
// Composer index
// ------------------------------------------------------------------
let _composerIndex = null;
async function loadComposerIndex() {
  if (_composerIndex) return _composerIndex;
  const path = resolve(REPO_ROOT, 'data', 'composers-reference.json');
  const json = JSON.parse(await readFile(path, 'utf8'));
  const entries = [];
  for (const c of json.composers) {
    for (const alias of c.aliases) {
      const norm = alias.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      entries.push({ canonical: c.name, alias, norm });
    }
  }
  entries.sort((a, b) => b.norm.length - a.norm.length);
  _composerIndex = entries;
  return entries;
}

// ------------------------------------------------------------------
// Extraction JSON-LD
// ------------------------------------------------------------------
function extractEvents(html) {
  const $ = cheerio.load(html);
  const events = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) {
        if (it && it['@type'] === 'Event') events.push(it);
      }
    } catch {}
  });
  return events;
}

// Parse l'heure depuis le titre format "DD/MM/YYYY – HH:MM – ..."
// Fallback : extraction depuis startDate ISO en soustrayant 2h (le
// plugin MEC double-convertit le fuseau, donnant un offset +2h).
// Cas all-day (durée startDate→endDate > 6h sans heure dans le titre)
// → time = null (visite/concert day-long, pas une heure précise).
function parseDateTime(jsonld) {
  const title = decodeEntities(jsonld.name || '');
  const start = jsonld.startDate;
  const end = jsonld.endDate;
  // Tentative : titre "DD/MM/YYYY – HH:MM"
  const m = title.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*[\u2013\u2014-]?\s*(\d{1,2})[:h](\d{2})/);
  if (m) {
    const date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const time = `${m[4].padStart(2, '0')}:${m[5]}`;
    return { date, time };
  }
  // Fallback : startDate -2h, sauf si durée > 6h → time null
  if (start) {
    const d = new Date(start);
    if (!isNaN(d.getTime())) {
      const e = end ? new Date(end) : null;
      const durationHrs = e && !isNaN(e.getTime()) ? (e - d) / 36e5 : 0;
      d.setHours(d.getHours() - 2);
      const date = d.toISOString().slice(0, 10);
      if (durationHrs > 6) return { date, time: null };
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return { date, time: `${hh}:${mm}` };
    }
  }
  return { date: null, time: null };
}

// Nettoie le titre : retire le préfixe date/heure inline souvent inclus
// par MEC, garde le sous-titre véritable.
function cleanTitle(rawTitle) {
  let t = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim();
  // Retire préfixe "DD/MM/YYYY – HH:MM – " ou variantes
  t = t.replace(/^\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*[\u2013\u2014-]?\s*\d{1,2}[:h]\d{2}\s*[\u2013\u2014-]?\s*/, '');
  // Retire "DD/MM/YYYY - " seul
  t = t.replace(/^\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*[\u2013\u2014-]?\s*/, '');
  // Retire "& HH:MM – " résiduel (cas "3/10/2026 – 20:00 & 21:45 – Concert...")
  t = t.replace(/^\s*&\s*\d{1,2}[:h]\d{2}\s*[\u2013\u2014-]?\s*/, '');
  return t.trim();
}

function isoToday() { return new Date().toISOString().slice(0, 10); }

function buildId(date, time, slug) {
  const t = time ? `-${time.replace(':', '')}` : '';
  return `cathedralis-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeCathedralisBruxellensis({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  console.error(`[cathedralis] list ${BASE_URL}${LIST_PATH}`);
  const html = await fetchHtml(`${BASE_URL}${LIST_PATH}`);
  const events = extractEvents(html);
  console.error(`[cathedralis] ${events.length} événements JSON-LD trouvés`);

  const concerts = [];
  let past = 0, skipped = 0;
  const skipBuckets = new Map();

  for (const ev of events) {
    const rawTitle = ev.name || '';
    const decoded = decodeEntities(rawTitle);

    // Filtre éditorial
    const skipMatch = SKIP_TITLE_PATTERNS.find((p) => p.test(decoded));
    if (skipMatch) {
      skipped++;
      const k = skipMatch.source.replace(/\\/g, '');
      skipBuckets.set(k, (skipBuckets.get(k) || 0) + 1);
      continue;
    }

    const { date, time } = parseDateTime(ev);
    if (!date) continue;
    if (date < today) { past++; continue; }

    const title = cleanTitle(rawTitle);
    const url = ev.url || null;
    const slug = url ? url.replace(/\/$/, '').split('/').pop() : 'event';

    // Lieu : la quasi-totalité à la cathédrale ; certains au parvis,
    // déjà filtrés par SKIP (fanfare). On garde tout cathedrale-saint-michel.
    const venueId = 'cathedrale-saint-michel-bruxelles';

    // Composers detected from title (program riche pas exposé dans
    // l'archive JSON-LD ; détail page nécessiterait fetch supplémentaire).
    const composers = matchComposers(title, composerIndex);

    concerts.push({
      id: buildId(date, time, slug),
      source: 'cathedralis',
      venue_id: venueId,
      title,
      date,
      time,
      url,
      composers,
      performers: [],
      program: null,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
  }

  const skipStr = [...skipBuckets.entries()].map(([k, n]) => `${k}=${n}`).join(' ');
  console.error(`[cathedralis] retenus ${concerts.length} | passés ${past} | skip ${skipped} (${skipStr})`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeCathedralisBruxellensis()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
