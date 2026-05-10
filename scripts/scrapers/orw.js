// Scraper Opéra Royal de Wallonie — saison lyrique liégeoise
//
// Stratégie :
//  1. Liste : la page /evenement/ rend ses cartes via AJAX. Heureusement
//     l'endpoint /wp-json/orw/v1/calendar?saisons=ID&view=columns&lang=fr
//     renvoie le HTML brut des cartes. On découvre les saisons disponibles
//     en parsant le <select id="select_saison"> de /evenement/, puis on
//     boucle sur chaque saison (en pratique : la courante + la suivante si
//     présente).
//  2. Pré-filtre : chaque carte porte des <span class="term">…</span>. On
//     garde si au moins un term "musical" est présent (Opéra, Ballet,
//     Concert, Création, Spectacle, Opéra Jeune Public). On rejette si on
//     ne voit que Animation / Visite / Portes ouvertes / Clés d'écoute
//     (ateliers pédagogiques, conférences, visites — exclus par éditorial).
//  3. Détail : pour chaque page d'événement gardée, on visite une fois
//     pour récupérer toutes les dates (h3 dans .utick_item__header), la
//     distribution structurée (cast_list avec rôles), la description et le
//     compositeur (champ .compositors visible aussi sur la liste).
//  4. La page événement liste TOUTES les représentations — on émet un
//     concert par occurrence.

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const BASE_URL = 'https://www.operaliege.be';
const ARCHIVE_PATH = '/evenement/';
const CALENDAR_API = '/wp-json/orw/v1/calendar';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Termes qui justifient à eux seuls de garder l'événement.
const KEEP_TERMS = new Set([
  'opera', 'opera jeune public',
  'concert',
  'ballet',
  'creation',
  'spectacle',
]);

// Termes qui font rejeter SI aucun KEEP_TERMS n'est présent.
const REJECT_TERMS = new Set([
  'animation',
  'visite',
  'portes ouvertes',
  'cles d ecoute',
]);

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

function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
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
// Discovery — saisons disponibles
// ------------------------------------------------------------------
async function discoverSaisons() {
  const html = await fetchHtml(BASE_URL + ARCHIVE_PATH);
  const $ = cheerio.load(html);
  const out = [];
  $('#select_saison option').each((_, el) => {
    const $o = $(el);
    const value = $o.attr('value') || '';
    const label = $o.text().trim();
    if (value && /^\d+$/.test(value)) {
      out.push({ id: parseInt(value, 10), label, selected: $o.attr('selected') === 'selected' });
    }
  });
  return out;
}

// ------------------------------------------------------------------
// List parsing (réponse de /wp-json/orw/v1/calendar)
// ------------------------------------------------------------------
function parseCalendarPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('.m_events__block').each((_, el) => {
    const $el = $(el);
    const $a = $el.find('h3.m_events__title a').first();
    const href = $a.attr('href') || '';
    if (!href) return;
    const url = href.replace(/\/$/, '');
    const title = $a.text().trim().replace(/\s+/g, ' ');
    const compositors = $el.find('p.compositors').first().text().trim().replace(/\s+/g, ' ');
    const terms = $el.find('p.terms .term').toArray().map((s) => normalize($(s).text()));
    items.push({ url, title, compositors, terms });
  });
  return items;
}

function isAllowed(item) {
  // Politique stricte : on n'accepte qu'un événement explicitement taggé
  // musical (Opéra, Ballet, Concert, Création, Spectacle, Opéra Jeune
  // Public). Cela évite que les événements taggés uniquement "Événement"
  // (vente de costumes, CIDOO, etc.) ou uniquement "Pour tous" passent.
  return item.terms.some((t) => KEEP_TERMS.has(t));
}

// ------------------------------------------------------------------
// Detail page parsing
// ------------------------------------------------------------------
function parseFrenchDate(s) {
  // Ex : "samedi 22 août 2026 - 20h00" ; "ven. 7 nov. 2026 - 20h00"
  const m = s.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\s+(\d{4})(?:\s*-\s*(\d{1,2})\s*[hH:](\d{0,2}))?/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monKey = normalize(m[2]).replace(/\.$/, '');
  // Map abbr → full
  const abbrMap = { jan: 'janvier', fev: 'fevrier', mar: 'mars', avr: 'avril',
    mai: 'mai', jun: 'juin', juil: 'juillet', aou: 'aout', sep: 'septembre',
    oct: 'octobre', nov: 'novembre', dec: 'decembre' };
  const fullKey = MONTHS_FR[monKey] ? monKey : (abbrMap[monKey.slice(0,3)] || monKey);
  const month = MONTHS_FR[fullKey];
  if (!month) return null;
  const year = parseInt(m[3], 10);
  const hour = m[4] ? parseInt(m[4], 10) : null;
  const minute = m[5] ? parseInt(m[5], 10) || 0 : (m[4] ? 0 : null);
  return {
    date: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
    time: hour !== null ? `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}` : null,
  };
}

function parseDetailPage(html, composerIndex) {
  const $ = cheerio.load(html);
  const title = $('h1.m_headline__title').first().text().trim().replace(/\s+/g, ' ');

  // Dates : chaque .utick_item__header > .left > h3.h4 contient une représentation
  const dates = [];
  $('.utick_item__header h3').each((_, el) => {
    const txt = $(el).text().trim().replace(/\s+/g, ' ');
    const parsed = parseFrenchDate(txt);
    if (parsed) dates.push(parsed);
  });

  // Distribution structurée
  const performers = [];
  $('.cast_list a.artist').each((_, el) => {
    const $el = $(el);
    const role = $el.find('.role').first().text().trim();
    // Le nom est le texte hors .role / .custom / .add_to_wishlist
    const $clone = $el.clone();
    $clone.find('.role, .custom, .add_to_wishlist, svg').remove();
    const name = $clone.text().replace(/\s+/g, ' ').trim();
    if (!name) return;
    performers.push(role ? `${name} (${role})` : name);
  });

  // Compositeurs : champ .m_article__event-compositeurs (peut être vide) +
  // champ <p class="compositors"> de la liste passé en complément.
  const detailComposersText = $('.m_article__event-compositeurs').first().text().trim().replace(/\s+/g, ' ');

  // Description (1er paragraphe)
  const description = $('.description__content p').first().text().trim().replace(/\s+/g, ' ');

  // Lieu : ORW joue surtout dans son théâtre, mais certaines représentations
  // hors-les-murs apparaissent. Pas exposé dans une div dédiée. On laisse à
  // null pour l'instant.

  return { title, dates, performers, detailComposersText, description };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function buildId(date, url, time) {
  const slug = (url.match(/\/evenement\/([^/?#]+)/) || [])[1] || 'event';
  const t = time ? `-${time.replace(':', '')}` : '';
  return `orw-${date}${t}-${slug}`.replace(/--+/g, '-').slice(0, 200);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapeORW({
  detailDelay = 350,
  saisonDelay = 250,
} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // 1. Découverte des saisons
  const saisons = await discoverSaisons();
  console.error(`[orw] saisons disponibles: ${saisons.map((s) => `${s.label}${s.selected ? '*' : ''}`).join(', ')}`);

  // On garde la saison sélectionnée + toutes celles dont le label finit par
  // une année ≥ année courante (i.e. saisons à venir ou en cours).
  const currentYear = new Date().getFullYear();
  const targetSaisons = saisons.filter((s) => {
    const m = s.label.match(/(\d{4})\s*-\s*(\d{4})/);
    if (!m) return s.selected;
    return parseInt(m[2], 10) >= currentYear;
  });

  // 2. Liste via API JSON
  let listed = [];
  for (const sa of targetSaisons) {
    const url = `${BASE_URL}${CALENDAR_API}?saisons=${sa.id}&view=columns&lang=fr`;
    try {
      console.error(`[orw] calendrier saison ${sa.label} (id=${sa.id})`);
      const html = await fetchHtml(url);
      const items = parseCalendarPage(html);
      listed.push(...items);
    } catch (err) {
      console.error(`[orw] saison ${sa.label} failed: ${err.message}`);
    }
    await sleep(saisonDelay);
  }

  // Dédupe par URL (un même événement peut apparaître sur 2 saisons en
  // chevauchement)
  const seen = new Set();
  listed = listed.filter((it) => {
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  const allowed = listed.filter(isAllowed);
  console.error(`[orw] ${listed.length} événements / ${allowed.length} retenus (filtre éditorial)`);

  // 3. Détail (cache par URL) + expansion par occurrence
  const concerts = [];
  for (const item of allowed) {
    let detail = null;
    try {
      const html = await fetchHtml(item.url);
      detail = parseDetailPage(html, composerIndex);
      await sleep(detailDelay);
    } catch (err) {
      console.error(`[orw] detail failed for ${item.url}: ${err.message}`);
      continue;
    }

    // Compositeurs : on combine la liste, le détail et la description (la
    // mention "Puccini, Strauss, Massenet, Ravel" arrive souvent dans le
    // texte). Pour éviter les faux positifs, on fait le matching sur la
    // concat des champs explicites (compositors + detailComposers) en
    // priorité, sinon sur la description.
    let composerBlob = [item.compositors, detail.detailComposersText].filter(Boolean).join(' ');
    if (!composerBlob.trim()) composerBlob = detail.description || '';
    const composers = matchComposers(composerBlob, composerIndex);

    if (detail.dates.length === 0) {
      console.error(`[orw] aucune date trouvée pour ${item.url} — ignoré`);
      continue;
    }

    for (const occ of detail.dates) {
      if (occ.date < today) continue;
      concerts.push({
        id: buildId(occ.date, item.url, occ.time),
        source: 'orw',
        venue_id: 'orw',
        title: detail.title || item.title,
        date: occ.date,
        time: occ.time,
        url: item.url,
        composers,
        performers: detail.performers,
        program: detail.description || item.compositors || null,
        price_min: null,
        price_max: null,
        scraped_at: new Date().toISOString(),
      });
    }
  }

  console.error(`[orw] ${concerts.length} concerts produits`);
  return concerts;
}

// CLI direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  scrapeORW()
    .then((concerts) => {
      process.stdout.write(JSON.stringify(concerts, null, 2) + '\n');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
