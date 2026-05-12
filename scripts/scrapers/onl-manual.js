// Loader Orchestre National de Lille — saison encodée manuellement
//
// Pattern Phase 3.18 OBV adapté au schéma ONL. Le site onlille.com
// utilise un CMS Drupal mais la saison 26-27 (le cinquantenaire) n'est
// pas encore disponible en HTML scrappable au 12 mai 2026 — on encode
// depuis la brochure officielle (PDF dossier de presse).
//
// Source : data/manual-sources/onl-{season}.json
// Le loader agrège toutes les saisons présentes dans ce dossier,
// remappe les venue_ids ONL → venue_ids canoniques quand un venue
// existe déjà sous un autre nom (Nouveau Siècle, Concertgebouw,
// Soissons), filtre les dates passées, et émet des objets concerts
// standard.
//
// Schéma JSON par production (différent d'OBV) :
//   - production avec un tableau `program` (liste {composer, work, ...})
//   - `conductor` ou `conductors` (gala)
//   - `soloists` (liste {name, instrument/role})
//   - `performances` (liste {date, time, venue_id, ticketing?})
//   - `co_production` (ex. "opera-de-lille") pour les co-productions
//     déjà identifiées comme couvertes par un autre scraper

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const MANUAL_DIR = resolve(REPO_ROOT, 'data', 'manual-sources');

// Remap venue_ids du JSON manuel ONL → venue_ids déjà existants dans
// data/venues.json pour ne pas dupliquer les venues.
const VENUE_REMAP = {
  'onl-nouveau-siecle-lille': 'nouveausiecle',
  'concertgebouw-bruges': 'concertgebouwbrugge',
  'cite-musique-danse-soissons': 'cite-musique-soissons',
  'operalille': 'operalille',  // identité
};

function normalize(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
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
// Helpers
// ------------------------------------------------------------------
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildId(date, time, productionId, occurrenceIdx) {
  const t = time ? `-${time.replace(':', '')}` : '';
  return `${productionId}-${date}${t}-occ${occurrenceIdx}`.replace(/--+/g, '-').slice(0, 200);
}

function remapVenue(rawId) {
  return VENUE_REMAP[rawId] || rawId;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function loadONLManual({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  // Charge tous les fichiers onl-*.json
  let files;
  try {
    const { readdir } = await import('node:fs/promises');
    files = (await readdir(MANUAL_DIR)).filter((f) => /^onl-.*\.json$/i.test(f));
  } catch (err) {
    console.error(`[onl-manual] dossier ${MANUAL_DIR} inaccessible : ${err.message}`);
    return [];
  }
  console.error(`[onl-manual] ${files.length} fichier(s) saison : ${files.join(', ')}`);

  const concerts = [];
  for (const file of files) {
    const path = resolve(MANUAL_DIR, file);
    let json;
    try {
      json = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      console.error(`[onl-manual]   ${file} parse error : ${err.message}`);
      continue;
    }
    const productions = json.productions || [];
    const season = (json.source && json.source.season) || 'unknown';
    const website = (json.source && json.source.website) || 'https://www.onlille.com';
    console.error(`[onl-manual]   ${file} : ${productions.length} productions, saison ${season}`);

    for (const prod of productions) {
      const perfs = prod.performances || [];
      // Composers : combine tous les composer des items de program +
      // matching contre composers-reference.json pour canonicaliser.
      const composerSet = new Set();
      const rawComposers = (prod.program || [])
        .map((p) => p.composer)
        .filter(Boolean);
      const blob = `${prod.title || ''} ${rawComposers.join(' ')}`;
      const matched = matchComposers(blob, composerIndex);
      for (const c of matched) composerSet.add(c);
      // Si aucun match canonique trouvé, conserver les noms bruts
      // (ils seront nettoyés/splités par cleanComposers en passe finale).
      if (composerSet.size === 0) {
        for (const c of rawComposers) composerSet.add(c);
      }
      const composers = [...composerSet];

      perfs.forEach((p, idx) => {
        if (!p.date || p.date < today) return;
        const venueId = remapVenue(p.venue_id);
        const programParts = [];
        // Conductor(s)
        if (prod.conductor) programParts.push(`direction : ${prod.conductor}`);
        else if (prod.conductors && prod.conductors.length) programParts.push(`direction : ${prod.conductors.join(' / ')}`);
        // Soloists
        if (prod.soloists && prod.soloists.length) {
          const sols = prod.soloists.map((s) => s.name + (s.instrument ? ` (${s.instrument})` : s.role ? ` (${s.role})` : '')).join(', ');
          programParts.push(sols);
        }
        // With ensemble (chœur, etc.)
        if (prod.with_ensemble) programParts.push(`avec ${prod.with_ensemble}`);
        // Programme : 1-2 œuvres principales
        if (prod.program && prod.program.length) {
          const works = prod.program.slice(0, 3).map((w) => `${w.composer} — ${w.work}`).join(' · ');
          if (works) programParts.push(works);
        }
        // Co-production note
        if (prod.co_production) programParts.push(`co-production ${prod.co_production}`);
        if (p.ticketing) programParts.push(`billetterie : ${p.ticketing}`);

        concerts.push({
          id: buildId(p.date, p.time, prod.production_id, idx + 1),
          source: 'onl',
          venue_id: venueId,
          title: prod.title,
          date: p.date,
          time: p.time || null,
          url: prod.url_detail || website,
          composers,
          performers: prod.soloists ? prod.soloists.map((s) => s.name) : [],
          program: programParts.length ? programParts.join(' — ').slice(0, 500) : null,
          price_min: null,
          price_max: null,
          scraped_at: new Date().toISOString(),
        });
      });
    }
  }

  console.error(`[onl-manual] ${concerts.length} représentations à venir produites`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadONLManual()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
