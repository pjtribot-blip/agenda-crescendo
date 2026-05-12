// Utilitaire — nettoyage des composers en sortie d'agrégation.
//
// Plusieurs scrapers (Bozar et CMS similaires) emettent des noms bruts
// dans `composers` quand le CMS source confond performer et composer
// (ex. "Lea Desandre & Ensemble Jupiter") ou regroupe plusieurs
// compositeurs en une seule entrée (ex. "Correa de Arauxo, Cabezón,
// Cabanilles"). On applique 3 règles :
//
//   1. Hard blacklist (NON_COMPOSER_NAMES) — noms qu'on sait ne pas
//      être des compositeurs.
//   2. Patterns d'ensemble — "Ensemble X", "Quatuor Y", "Orchestre Z",
//      "& Choir", etc. → rejeté.
//   3. Split listes virgule — 2+ virgules dans un nom = liste à
//      découper en compositeurs distincts. Chaque morceau est
//      ensuite canonicalisé via composers-reference.json si possible.
//
// Le pipeline est appliqué dans aggregate.js sur tous les concerts
// après l'agrégation, donc indépendant de chaque scraper.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Hard blacklist : noms qui apparaissent dans des champs "composer"
// d'un CMS source mais qui sont en réalité des interprètes.
export const NON_COMPOSER_NAMES = new Set([
  'julie andrews',
  'lea desandre',
  'lucio gallo',
  'claudio chiara',
  'claudio chiara jazz quintet',
  'ensemble jupiter',
]);

// Patterns d'ensembles/interprètes (mot-clé délimité par boundaries).
// Un nom qui matche un de ces patterns est un ensemble, jamais un
// compositeur. `\borchestr` couvre orchestre/orchestra/orchestral.
const ENSEMBLE_PATTERNS = [
  /\bensemble\b/i,
  /\bquartet(?:to)?\b/i,
  /\bquatuor\b/i,
  /\bquintet(?:te|to)?\b/i,
  /\btrio\b/i,
  /\borchestr/i,
  /\bchoir\b/i,
  /\bch(?:œ|oe)ur\b/i,
  /\bcoro\b/i,
  /\bphilharmoni(?:c|que)\b/i,
  /\bsextet\b/i,
  /\boctet\b/i,
  /\bsymphony orchestra\b/i,
  /\bbig band\b/i,
];

export function isNonComposer(name) {
  if (!name) return true;
  const norm = normalize(name);
  if (NON_COMPOSER_NAMES.has(norm)) return true;
  if (ENSEMBLE_PATTERNS.some((re) => re.test(name))) return true;
  return false;
}

// Découpe "A, B, C" en ["A","B","C"] si 3+ morceaux. Conserve l'entrée
// originale si moins de 2 virgules (pour ne pas couper "Bach, J.S." ou
// les rares noms avec une virgule). Strip "…" et "..." en fin.
export function splitComposerList(name) {
  if (!name || !name.includes(',')) return [name];
  const rawParts = name.split(',').map((p) =>
    p.trim().replace(/\s*[…]+\s*$/, '').replace(/\s*\.\.\.\s*$/, '')
  ).filter(Boolean);
  if (rawParts.length < 3) return [name];
  // Sécurité : si une part est juste une initiale (ex. "J.S."), c'est
  // qu'on a coupé un nom inverse ("Bach, J.S.") → on garde l'original.
  if (rawParts.some((p) => /^[A-Z]\.([A-Z]\.?)?$/.test(p) || p.length < 2)) {
    return [name];
  }
  return rawParts;
}

// Cherche le canonical d'un nom dans composerIndex (issu de
// composers-reference.json). Match exact d'abord, puis inclusion
// pour les alias longs (>3 chars) afin d'éviter "Bach" qui matcherait
// "Offenbach" — on se repose sur la liste d'alias pour les cas
// ambigus.
export function lookupCanonical(name, composerIndex) {
  if (!name) return null;
  const norm = normalize(name);
  // Match exact d'abord
  for (const { canonical, norm: alias } of composerIndex) {
    if (norm === alias) return canonical;
  }
  // Inclusion stricte (alias inclus dans le nom)
  for (const { canonical, norm: alias } of composerIndex) {
    if (alias.length > 3 && norm.includes(alias)) return canonical;
  }
  return null;
}

// Patterns d'ensembles : si l'alias d'un compositeur apparaît
// précédé ou suivi de l'un de ces mots, c'est probablement un nom
// d'ensemble (Cuarteto Casals, Schumann Quartett, Tallis Scholars).
const ENSEMBLE_AFTER = /^(quartet+|quatuor|cuarteto|ensemble|trio|scholars|players|singers|quintet+(?:to|te)?|choir|orchestra|orchestre|sinfonia|soloists|consort|chamber)$/i;
const ENSEMBLE_BEFORE = /^(quatuor|cuarteto|ensemble|quintet+(?:to|te)?|trio|orchestra|orchestre|choeur|coro|choir|sextuor|sinfonia)$/i;

// Patterns d'hommage : « Bruckner Etude », « Mozartiana »,
// « Hommage à X », « In memoriam X », « Variations sur un thème de X ».
// L'alias est référencé comme inspiration, pas comme auteur.
const HOMMAGE_AFTER = /^(etude|variations?|fantaisies?|memoriam|hommage)$/i;
const HOMMAGE_BEFORE = /^(hommage|memoriam|sur|d'apres|d'après|apres|inspire|inspiré|in)$/i;

// Augmentation : pour chaque alias trouvé dans title+program (avec
// word boundary), on ajoute le canonical aux composers du concert,
// SAUF si toutes les occurrences sont dans un contexte ensemble ou
// hommage. Retourne la liste des canonicals à ajouter (déjà filtrés
// contre ceux déjà présents).
export function augmentComposers(concert, composerIndex) {
  const blob = ((concert.title || '') + ' ' + (concert.program || ''));
  const norm = normalize(blob);
  const currentNorm = new Set((concert.composers || []).map(normalize));
  const additions = new Set();
  for (const { canonical, norm: alias } of composerIndex) {
    if (currentNorm.has(normalize(canonical))) continue;
    if (alias.length < 4) continue;          // trop court → trop ambigu
    const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`, 'g');
    const matches = [...norm.matchAll(re)];
    if (!matches.length) continue;

    // Pour chaque occurrence, vérifier le contexte (mot avant et
    // après). Si TOUTES les occurrences sont dans un contexte
    // ensemble/hommage, on rejette. Sinon on accepte.
    let validCount = 0;
    for (const m of matches) {
      const start = m.index;
      const end = start + alias.length;
      // Mot avant : depuis le dernier séparateur jusqu'à start-1
      let i = start - 1;
      while (i >= 0 && /[^a-z0-9]/.test(norm[i])) i--;
      const beforeEnd = i + 1;
      while (i >= 0 && /[a-z0-9]/.test(norm[i])) i--;
      const beforeWord = norm.slice(i + 1, beforeEnd);
      // Mot après : depuis end+ jusqu'au prochain séparateur
      let j = end;
      while (j < norm.length && /[^a-z0-9]/.test(norm[j])) j++;
      const afterStart = j;
      while (j < norm.length && /[a-z0-9]/.test(norm[j])) j++;
      const afterWord = norm.slice(afterStart, j);

      if (ENSEMBLE_AFTER.test(afterWord)) continue;
      if (ENSEMBLE_BEFORE.test(beforeWord)) continue;
      if (HOMMAGE_AFTER.test(afterWord)) continue;
      if (HOMMAGE_BEFORE.test(beforeWord)) continue;
      validCount++;
    }
    if (validCount > 0) additions.add(canonical);
  }
  return [...additions];
}

// Pipeline complet : applique blacklist, split, canonicalize, dédupe.
export function cleanComposers(rawList, composerIndex) {
  if (!Array.isArray(rawList) || !rawList.length) return [];
  const seen = new Set();
  const out = [];
  for (const raw of rawList) {
    if (isNonComposer(raw)) continue;
    for (const part of splitComposerList(raw)) {
      if (isNonComposer(part)) continue;
      const canonical = lookupCanonical(part, composerIndex) || part.trim();
      if (!canonical) continue;
      const key = normalize(canonical);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(canonical);
    }
  }
  return out;
}

// Charge l'index composers-reference.json (utilisable hors scrapers).
export async function loadComposerIndex() {
  const path = resolve(REPO_ROOT, 'data', 'composers-reference.json');
  const json = JSON.parse(await readFile(path, 'utf8'));
  const entries = [];
  for (const c of json.composers) {
    for (const alias of c.aliases) {
      entries.push({ canonical: c.name, alias, norm: normalize(alias) });
    }
  }
  entries.sort((a, b) => b.norm.length - a.norm.length);
  return entries;
}
