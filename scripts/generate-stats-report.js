// Génère un rapport markdown de statistiques pour l'agenda
// Crescendo. Le fichier est écrit dans reports/stats-YYYY-MM-DD.md
// avec toutes les sections utilisables directement pour l'article
// fondateur dans Crescendo Magazine.
//
// Usage : node scripts/generate-stats-report.js
// (équivalent : npm run stats-report)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

// ------------------------------------------------------------------
// Heuristiques éditoriales (non parfaites, à raffiner dans
// composers-reference.json au fil du temps)
// ------------------------------------------------------------------
const FEMALE_COMPOSERS = new Set([
  'Hildegard von Bingen', 'Clara Schumann', 'Fanny Mendelssohn',
  'Lili Boulanger', 'Nadia Boulanger', 'Boulanger',
  'Andrea Tarrodi', 'Anna Thorvaldsdottir', 'Caroline Shaw',
  'Laura Kaminsky', 'Kristine Tjøgersen', 'Raquel García-Tomás',
  'Natalie Beridze', 'Francesca Caccini', 'Strozzi',
  'Bembo', 'Francesca Campana', 'Saariaho', 'Beach',
  'Van den Boorn-Coclet',
]);

const BELGIAN_COMPOSERS = new Set([
  'Lekeu', 'Ysaÿe', 'Franck', 'Grétry', 'Vieuxtemps', 'Servais',
  'Jongen', 'Gilson', 'Absil', 'Boesmans', 'Henderickx',
  'Van den Boorn-Coclet', 'Swerts',
]);

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function pct(n, total) {
  if (!total) return '0.0';
  return ((n / total) * 100).toFixed(1);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function pad(s, w) {
  return String(s).padEnd(w);
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  const headerRow = '| ' + headers.map((h, i) => pad(h, widths[i])).join(' | ') + ' |';
  const dataRows = rows.map((r) => '| ' + r.map((c, i) => pad(c ?? '', widths[i])).join(' | ') + ' |');
  return [headerRow, sep, ...dataRows].join('\n');
}

function monthLabel(ym) {
  const [y, m] = ym.split('-');
  const months = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

// ------------------------------------------------------------------
// Computations
// ------------------------------------------------------------------
function computeStats(concerts, venues, festivals) {
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const festivalById = new Map(festivals.map((f) => [f.id, f]));
  const today = todayIso();
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() + 12);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const upcoming = concerts.filter((c) => c.date && c.date >= today && c.date <= cutoffIso);

  // Bloc 1 — Couverture globale
  const sources = new Set(concerts.map((c) => c.source));
  const venuesUsed = new Set(concerts.map((c) => c.venue_id).filter(Boolean));
  const allComposers = new Set();
  for (const c of concerts) for (const x of (c.composers || [])) allComposers.add(x);
  const taggedFestivals = new Set();
  for (const c of concerts) {
    if (c.festival) taggedFestivals.add(c.festival);
    for (const f of (c.festivals || [])) taggedFestivals.add(f);
  }
  const countries = new Set();
  for (const c of concerts) {
    const v = venueById.get(c.venue_id);
    if (v && v.country) countries.add(v.country);
  }

  // Bloc 2 — Répartition géographique
  const byCountry = new Map();
  for (const c of upcoming) {
    const v = venueById.get(c.venue_id);
    if (!v) continue;
    byCountry.set(v.country, (byCountry.get(v.country) || 0) + 1);
  }
  const byRegion = new Map();
  for (const c of upcoming) {
    const v = venueById.get(c.venue_id);
    if (!v || v.country !== 'BE') continue;
    const r = v.region || '(?)';
    byRegion.set(r, (byRegion.get(r) || 0) + 1);
  }
  const byVenue = new Map();
  for (const c of upcoming) {
    if (!c.venue_id) continue;
    byVenue.set(c.venue_id, (byVenue.get(c.venue_id) || 0) + 1);
  }
  const topVenues = [...byVenue].sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Bloc 3 — Saison / temporalité
  const byMonth = new Map();
  for (const c of upcoming) {
    const ym = c.date.slice(0, 7);
    byMonth.set(ym, (byMonth.get(ym) || 0) + 1);
  }
  const monthsSorted = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxMonth = monthsSorted.reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);
  const minMonth = monthsSorted.reduce((a, b) => (b[1] < a[1] ? b : a), monthsSorted[0] || ['', 0]);
  const nextConcert = upcoming.sort((a, b) => a.date.localeCompare(b.date))[0];
  const daysUntilNext = nextConcert ? Math.max(0, Math.round((new Date(nextConcert.date) - new Date(today)) / (24 * 3600 * 1000))) : null;

  // Bloc 4 — Compositeurs
  const composerCount = new Map();
  for (const c of upcoming) for (const x of (c.composers || [])) composerCount.set(x, (composerCount.get(x) || 0) + 1);
  const topComposers = [...composerCount].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const femaleFound = [...composerCount.keys()].filter((n) => FEMALE_COMPOSERS.has(n));
  const belgianFound = [...composerCount.keys()].filter((n) => BELGIAN_COMPOSERS.has(n));

  // Bloc 5 — Festivals
  const festivalCounts = new Map();
  for (const c of upcoming) {
    if (c.festival) festivalCounts.set(c.festival, (festivalCounts.get(c.festival) || 0) + 1);
    for (const f of (c.festivals || [])) festivalCounts.set(f, (festivalCounts.get(f) || 0) + 1);
  }
  const topFestivals = [...festivalCounts].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const concertsInFestival = upcoming.filter((c) => c.festival || (c.festivals && c.festivals.length)).length;
  // Festival le plus long (en jours)
  let longestFestival = null;
  for (const f of festivals) {
    if (!f.date_start || !f.date_end) continue;
    const days = Math.round((new Date(f.date_end) - new Date(f.date_start)) / (24 * 3600 * 1000)) + 1;
    if (!longestFestival || days > longestFestival.days) longestFestival = { id: f.id, name: f.name, days };
  }

  // Bloc 6 — Qualité éditoriale
  const withProgram = upcoming.filter((c) => c.program && c.program.length > 5).length;
  const withPerformers = upcoming.filter((c) => Array.isArray(c.performers) && c.performers.length > 0).length;
  const withUrl = upcoming.filter((c) => c.url && c.url.startsWith('http')).length;

  return {
    today,
    cutoffIso,
    upcomingTotal: upcoming.length,
    sources: sources.size,
    venuesUsed: venuesUsed.size,
    venuesTotal: venues.length,
    composersTotal: allComposers.size,
    festivalsTagged: taggedFestivals.size,
    festivalsTotal: festivals.length,
    countries: countries.size,
    byCountry: [...byCountry].sort((a, b) => b[1] - a[1]),
    byRegion: [...byRegion].sort((a, b) => b[1] - a[1]),
    topVenues, byMonth: monthsSorted, maxMonth, minMonth,
    daysUntilNext, nextConcert,
    topComposers, femaleFound, belgianFound,
    topFestivals, concertsInFestival, longestFestival,
    withProgram, withPerformers, withUrl,
    venueById, festivalById,
  };
}

// ------------------------------------------------------------------
// Markdown report rendering
// ------------------------------------------------------------------
function renderReport(s) {
  const lines = [];
  lines.push(`# Statistiques Agenda Crescendo`);
  lines.push(`*Génération automatique du ${s.today}*`);
  lines.push('');
  lines.push(`Périmètre : concerts à venir entre ${s.today} et ${s.cutoffIso} (12 mois roulants).`);
  lines.push('');

  // Bloc 1
  lines.push(`## 1. Couverture globale`);
  lines.push('');
  lines.push(table(['Métrique', 'Valeur'], [
    ['Concerts à venir (12 mois)', s.upcomingTotal.toLocaleString('fr-BE')],
    ['Sources actives', s.sources],
    ['Venues géolocalisés (utilisés / total)', `${s.venuesUsed} / ${s.venuesTotal}`],
    ['Festivals taggés (utilisés / définis)', `${s.festivalsTagged} / ${s.festivalsTotal}`],
    ['Compositeurs distincts joués', s.composersTotal],
    ['Pays couverts', `${s.countries} (${s.byCountry.map(([c]) => c).join(', ')})`],
  ]));
  if (s.nextConcert) {
    lines.push('');
    lines.push(`**Prochain concert** : ${s.nextConcert.date} — ${s.nextConcert.title.slice(0, 80)} (dans ${s.daysUntilNext} jour${s.daysUntilNext > 1 ? 's' : ''})`);
  }
  lines.push('');

  // Bloc 2
  lines.push(`## 2. Répartition géographique`);
  lines.push('');
  lines.push(`### Par pays`);
  lines.push(table(['Pays', 'Concerts', '%'], s.byCountry.map(([c, n]) => [c, n, `${pct(n, s.upcomingTotal)}%`])));
  lines.push('');
  lines.push(`### Belgique par région`);
  lines.push(table(['Région', 'Concerts', '%'], s.byRegion.map(([r, n]) => [r, n, `${pct(n, s.upcomingTotal)}%`])));
  lines.push('');
  lines.push(`### Top 10 venues`);
  lines.push(table(['Venue', 'Concerts'], s.topVenues.map(([id, n]) => {
    const v = s.venueById.get(id);
    return [v ? `${v.name} (${v.city})` : id, n];
  })));
  lines.push('');

  // Bloc 3
  lines.push(`## 3. Saison et temporalité`);
  lines.push('');
  lines.push(`### Histogramme mensuel`);
  const maxBar = Math.max(...s.byMonth.map(([, n]) => n), 1);
  for (const [ym, n] of s.byMonth) {
    const barLen = Math.round((n / maxBar) * 40);
    lines.push(`\`${pad(monthLabel(ym), 16)} ${pad(n, 4)} ${'█'.repeat(barLen)}\``);
  }
  lines.push('');
  lines.push(`- **Mois le plus dense** : ${monthLabel(s.maxMonth[0])} (${s.maxMonth[1]} concerts)`);
  if (s.minMonth) lines.push(`- **Mois le moins dense** : ${monthLabel(s.minMonth[0])} (${s.minMonth[1]} concerts)`);
  lines.push('');

  // Bloc 4
  lines.push(`## 4. Compositeurs`);
  lines.push('');
  lines.push(`### Top 20 compositeurs les plus joués`);
  lines.push(table(['#', 'Compositeur', 'Concerts'], s.topComposers.map(([n, c], i) => [i + 1, n, c])));
  lines.push('');
  lines.push(`### Compositrices identifiées (${s.femaleFound.length})`);
  if (s.femaleFound.length) {
    lines.push(s.femaleFound.map((n) => `- ${n} (${composerCountStr(n, s.topComposers)})`).join('\n'));
  } else {
    lines.push('*Aucune dans la programmation à venir détectée par l\'index FEMALE_COMPOSERS.*');
  }
  lines.push('');
  lines.push(`### Compositeurs belges identifiés (${s.belgianFound.length})`);
  if (s.belgianFound.length) {
    lines.push(s.belgianFound.map((n) => `- ${n} (${composerCountStr(n, s.topComposers)})`).join('\n'));
  } else {
    lines.push('*Aucun détecté par l\'index BELGIAN_COMPOSERS.*');
  }
  lines.push('');

  // Bloc 5
  lines.push(`## 5. Festivals`);
  lines.push('');
  lines.push(`### Top 10 festivals (par concerts taggés)`);
  lines.push(table(['Festival', 'Concerts'], s.topFestivals.map(([id, n]) => {
    const f = s.festivalById.get(id);
    return [f ? `${f.name} ${f.edition_year || ''}`.trim() : id, n];
  })));
  lines.push('');
  lines.push(`- **Pourcentage de concerts en festival** : ${pct(s.concertsInFestival, s.upcomingTotal)}% (${s.concertsInFestival} / ${s.upcomingTotal})`);
  if (s.longestFestival) {
    lines.push(`- **Festival le plus long** : ${s.longestFestival.name} (${s.longestFestival.days} jours)`);
  }
  lines.push('');

  // Bloc 6
  lines.push(`## 6. Qualité éditoriale`);
  lines.push('');
  lines.push(table(['Champ', 'Renseigné', '%'], [
    ['Programme', s.withProgram, `${pct(s.withProgram, s.upcomingTotal)}%`],
    ['Interprètes', s.withPerformers, `${pct(s.withPerformers, s.upcomingTotal)}%`],
    ['Lien externe', s.withUrl, `${pct(s.withUrl, s.upcomingTotal)}%`],
  ]));
  lines.push('');
  lines.push(`---`);
  lines.push(`*Rapport généré par \`scripts/generate-stats-report.js\` — Agenda Crescendo Magazine.*`);
  return lines.join('\n') + '\n';
}

function composerCountStr(name, topList) {
  const found = topList.find(([n]) => n === name);
  return found ? `${found[1]} concert${found[1] > 1 ? 's' : ''}` : '—';
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
async function main() {
  const concerts = JSON.parse(await readFile(resolve(REPO_ROOT, 'data', 'concerts.json'), 'utf8'));
  const venues = JSON.parse(await readFile(resolve(REPO_ROOT, 'data', 'venues.json'), 'utf8'));
  const festivals = JSON.parse(await readFile(resolve(REPO_ROOT, 'data', 'festivals.json'), 'utf8'));

  const stats = computeStats(concerts, venues, festivals);
  const md = renderReport(stats);

  const reportsDir = resolve(REPO_ROOT, 'reports');
  await mkdir(reportsDir, { recursive: true });
  const out = resolve(reportsDir, `stats-${stats.today}.md`);
  await writeFile(out, md, 'utf8');
  console.log(`✓ Rapport écrit : ${out}`);
  console.log(`  ${stats.upcomingTotal} concerts à venir, ${stats.sources} sources, ${stats.composersTotal} compositeurs.`);
}

main().catch((err) => { console.error('crashed:', err); process.exit(1); });
