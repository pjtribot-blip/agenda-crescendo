// Loader Opera Ballet Vlaanderen — saison encodée manuellement
//
// Le site officiel obv.be utilise Nuxt avec données minifiées dans
// une fermeture obfusquée — scraping impossible sans Playwright
// (Phase 2.7 reportée). On contourne en encodant la saison à la
// main depuis le dossier de presse officiel.
//
// Source : data/manual-sources/obv-{season}.json
// Le scraper agrège toutes les saisons présentes dans ce dossier,
// filtre les représentations passées, et émet des objets concerts
// standard.
//
// Une production = un titre/œuvre. Une représentation = une
// occurrence datée. Chaque production a un tableau `performances`
// avec date+time+venue_id.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { matchComposersFromText as matchComposers } from '../utils/composer-filter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const MANUAL_DIR = resolve(REPO_ROOT, 'data', 'manual-sources');

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

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
export async function loadOBVManual({} = {}) {
  const composerIndex = await loadComposerIndex();
  const today = isoToday();

  let files;
  try {
    files = (await readdir(MANUAL_DIR)).filter((f) => /^obv-.*\.json$/i.test(f));
  } catch (err) {
    console.error(`[obv-manual] dossier ${MANUAL_DIR} inaccessible : ${err.message}`);
    return [];
  }
  console.error(`[obv-manual] ${files.length} fichier(s) saison : ${files.join(', ')}`);

  const concerts = [];
  for (const file of files) {
    const path = resolve(MANUAL_DIR, file);
    let json;
    try {
      json = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      console.error(`[obv-manual]   ${file} parse error : ${err.message}`);
      continue;
    }
    const productions = json.concerts || [];
    console.error(`[obv-manual]   ${file} : ${productions.length} productions, saison ${json.season}`);

    for (const prod of productions) {
      const perfs = prod.performances || [];
      // Composers : matcher contre composer field + title pour récup
      // canonical names connus.
      const blob = `${prod.title || ''} ${prod.composer || ''}`;
      let composers = matchComposers(blob, composerIndex);
      // Fallback : si composer brut existe et pas matché, on l'ajoute tel quel
      if (composers.length === 0 && prod.composer) {
        // split sur " / " si plusieurs (ex. "Stravinsky / Puccini")
        const parts = prod.composer.split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
        composers = parts.length ? parts : [prod.composer];
      }

      perfs.forEach((p, idx) => {
        if (!p.date || p.date < today) return;
        const credits = prod.credits ? Object.entries(prod.credits).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
        const programParts = [];
        if (prod.type) programParts.push(prod.type[0].toUpperCase() + prod.type.slice(1));
        if (prod.is_world_creation) programParts.push('création mondiale');
        else if (prod.is_new_production) programParts.push('nouvelle production');
        if (p.is_premiere) programParts.push('première');
        if (credits) programParts.push(credits);
        if (p.note) programParts.push(p.note);

        concerts.push({
          id: buildId(p.date, p.time, prod.production_id, idx + 1),
          source: 'obv',
          venue_id: p.venue_id,
          title: prod.title,
          date: p.date,
          time: p.time || null,
          url: prod.url_detail || json.website || 'https://www.operaballet.be',
          composers,
          performers: [],
          program: programParts.length ? programParts.join(' — ') : null,
          price_min: null,
          price_max: null,
          scraped_at: new Date().toISOString(),
        });
      });
    }
  }

  console.error(`[obv-manual] ${concerts.length} représentations à venir produites`);
  return concerts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadOBVManual()
    .then((c) => process.stdout.write(JSON.stringify(c, null, 2) + '\n'))
    .catch((err) => { console.error(err); process.exit(1); });
}
