// Scraper Philharmonie Zuid-Nederland (Philzuid)
//
// Philzuid est l'orchestre symphonique régional du sud des Pays-Bas
// (Limburg + Noord-Brabant), avec Maastricht parmi ses villes de
// résidence. Le site philzuid.nl utilise Vue.js avec un index Algolia
// pour la liste des concerts — pas de HTML statique exploitable.
//
// Stratégie : interroger directement l'API Algolia (POST JSON), avec
// le header Referer https://philzuid.nl/ (sans ça → 403). La clé API
// est publique (search-only) et exposée dans le DOM via data-app-id /
// data-api-key.
//
// Périmètre éditorial Crescendo : on filtre `locationCity:Maastricht`
// via facetFilter Algolia (Maastricht est l'exception transfrontalière
// déjà admise dans la ligne éditoriale). Les concerts Philzuid à
// Eindhoven / Heerlen / Den Bosch / Tilburg etc. restent hors périmètre.
//
// Filtre titre : skip Vastelaovendconcerten (carnaval limbourgeois) —
// cohérence avec le filtre Vrijthof existant.

import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const ALGOLIA_ENDPOINT = 'https://ip15u4xwic-dsn.algolia.net/1/indexes/Events/query';
const ALGOLIA_APP_ID = 'IP15U4XWIC';
const ALGOLIA_API_KEY = '0cebf7ac16a749275c74d792923e6fe6';
const REFERER = 'https://philzuid.nl/';

const UA = 'Mozilla/5.0 (compatible; CrescendoMagazineBot/0.1; +https://crescendo-magazine.be) AgendaCrescendo';

// Skip titres carnaval (cohérence avec scraper Vrijthof — Vastelaovend
// = équivalent NL du carnaval limbourgeois, hors-périmètre classique).
const SKIP_TITLE = /vastelaovend|vastelaoves|\bcarnaval\b/i;

// ------------------------------------------------------------------
// Mapping locationText → venue_id
// ------------------------------------------------------------------
// Tous les concerts ramenés sont à Maastricht (facetFilter). Deux
// venues principaux à mapper : Theater aan het Vrijthof et Opus 9
// Theresiakerk. Si nouveau lieu apparaît, on log et on skip.
function mapVenue(locationText) {
  const t = (locationText || '').toLowerCase();
  if (t.includes('vrijthof')) return 'vrijthof-maastricht';
  if (t.includes('theresiakerk') || t.includes('opus 9') || t.includes('opus9')) {
    return 'opus9-theresiakerk-maastricht';
  }
  return null;
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
// Algolia query
// ------------------------------------------------------------------
async function fetchAlgolia({ retries = 2 } = {}) {
  const body = JSON.stringify({
    params: `hitsPerPage=200&facetFilters=${encodeURIComponent(JSON.stringify([['locationCity:Maastricht']]))}`,
  });
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ALGOLIA_ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Algolia-API-Key': ALGOLIA_API_KEY,
          'X-Algolia-Application-Id': ALGOLIA_APP_ID,
          'Referer': REFERER,
          'Origin': 'https://philzuid.nl',
          'Content-Type': 'application/json',
          'User-Agent': UA,
        },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, time, objectID) {
  const t = time ? `-${time.replace(':', '')}` : '';
  return `philzuid-${date}${t}-${objectID}`.slice(0, 200);
}

function clean(s, max = 500) {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function scrapePhilzuid({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  console.error(`[philzuid] Algolia query (facetFilter locationCity:Maastricht)`);
  const j = await fetchAlgolia();
  const hits = j.hits || [];
  console.error(`[philzuid] ${j.nbHits} hits ramenés`);

  const concerts = [];
  let past = 0, carnaval = 0, unknownVenue = 0;
  const unknownVenues = new Set();

  for (const h of hits) {
    if (!h.datetime) continue;
    const date = h.datetime.slice(0, 10);
    const time = h.datetime.slice(11, 16) || null;
    if (date < today) { past++; continue; }

    const title = clean(h.title, 200) || '';
    if (!title) continue;
    if (SKIP_TITLE.test(title)) { carnaval++; continue; }

    const venueId = mapVenue(h.locationText);
    if (!venueId) {
      unknownVenue++;
      unknownVenues.add(h.locationText);
      continue;
    }

    const performers = Array.isArray(h.artists) ? h.artists.slice(0, 10) : [];
    const composerBlob = [
      title,
      h.concert_heroSubtitle,
      h.base_introText,
      h.concert_programExplanation,
      h.base_content,
    ].filter(Boolean).join(' | ');
    const composers = matchComposers(composerBlob.slice(0, 3000), composerIndex);

    const program = clean(
      [h.concert_heroSubtitle, h.concert_programExplanation].filter(Boolean).join(' — '),
      500
    );

    concerts.push({
      id: buildId(date, time, h.objectID || h.id),
      source: 'philzuid',
      venue_id: venueId,
      title,
      date,
      time,
      url: h.url || null,
      composers,
      performers,
      program,
      price_min: null,
      price_max: null,
      scraped_at: new Date().toISOString(),
    });
  }

  if (unknownVenues.size) {
    console.error(`[philzuid] venues inconnus (ignorés) : ${[...unknownVenues].join(' | ')}`);
  }
  console.error(`[philzuid] retenus ${concerts.length} | passés ${past} | skip carnaval ${carnaval} | venue inconnu ${unknownVenue}`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrapePhilzuid()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
