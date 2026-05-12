# Agenda Crescendo

> Agenda éditorial des concerts de musique classique en Belgique et dans
> l'Eurorégion (Hauts-de-France, Luxembourg) — une initiative de
> [Crescendo Magazine](https://crescendo-magazine.be).

Application web *single-file* (HTML + CSS + JS inline) qui agrège les
programmes de 17 institutions musicales du périmètre Cercle 1, présentés
sur une carte interactive et dans une liste filtrable.

Approche cohérente avec les projets précédents :
[Festival Guide 2026](https://crescendo-festivals26.vercel.app) et
[Pauline](https://pauline-crescendo.vercel.app).

---

## Architecture

```
agenda-crescendo/
├── index.html              # Application complète — single-file
├── data/
│   ├── venues.json         # 20 lieux statiques géocodés (édité à la main)
│   └── concerts.json       # Régénéré chaque nuit (Phase 2)
├── scripts/
│   ├── scrapers/           # Phase 2 — un fichier par source
│   └── aggregate.js        # Phase 2 — fusion des scrapers
├── .github/workflows/
│   └── scrape-nightly.yml  # Phase 2 — cron quotidien à 04h UTC
├── package.json
├── README.md
└── .gitignore
```

### Stack technique

- **Frontend** : single-file HTML, Cormorant Garamond + Inter, palette
  ivoire/or éditoriale.
- **Cartographie** : [Leaflet](https://leafletjs.com) + tuiles CARTO Voyager
  (Light), via CDN.
- **Données** : deux fichiers JSON statiques chargés en `fetch` au boot.
- **Pas de framework**, pas de bundler, pas de runtime serveur.
- **Déploiement** : Vercel (statique).

---

## Sources — Cercle 1 (17 institutions, 20 salles)

### Belgique francophone
| Salle | Ville |
|---|---|
| Bozar | Bruxelles |
| La Monnaie / De Munt | Bruxelles |
| Flagey | Bruxelles |
| OPRL — Salle Philharmonique | Liège |
| Opéra Royal de Wallonie | Liège |
| Grand Manège | Namur |
| MARS — Mons Arts de la Scène | Mons |
| PBA Charleroi | Charleroi |
| Maison de la Culture | Tournai |
| Triangel | Saint-Vith |
| Ferme du Biéreau | Louvain-la-Neuve |

### Belgique néerlandophone
| Salle | Ville |
|---|---|
| Concertgebouw Brugge | Bruges |
| deSingel | Anvers |
| De Bijloke | Gand |
| Cultuurcentrum Hasselt | Hasselt |
| Muziekodroom | Hasselt |

### Eurorégion
| Salle | Ville |
|---|---|
| Nouveau Siècle (ONL) | Lille |
| Opéra de Lille | Lille |
| Atelier Lyrique de Tourcoing | Tourcoing |
| Philharmonie Luxembourg | Luxembourg |

---

## Phase 1 — Squelette et MVP visuel (✅ livré)

- [x] `index.html` single-file avec en-tête éditorial, carte Leaflet
      cliquable, liste de concerts en colonne, filtres, recherche, responsive
- [x] `data/venues.json` — 20 salles géocodées
- [x] `data/concerts.json` — 20 concerts de démo réalistes
- [x] `README.md`, `.gitignore`, `package.json`

## Phase 2 — Scrapers (en cours)

### Sources actives

| Source | Statut | Approche | Couverture |
|---|---|---|---|
| Bozar | ✅ opérationnel | HTML + cheerio (Drupal `section=527`, filtre taxonomique côté client) | ~50 concerts classiques sur 13 mois |
| La Monnaie / De Munt | ✅ opérationnel | HTML + cheerio (`/fr/calendar?m=YYYY-MM` mois par mois, filtre éditorial sur la catégorie + slug) | ~130 représentations opéra + concerts sur 14 mois |
| Flagey | ✅ opérationnel | HTML + cheerio (`/fr/agenda?ym=YYYY-MM`, pré-filtre Music sur la liste, filtre fin sur les tags Classique/Contemporain/Orchestre/Piano/Quatuor/Chant/… de la page détail, hard-reject Junior + sound installations) | ~70 concerts savants sur 14 mois |
| Concertgebouw Brugge | ✅ opérationnel | HTML + cheerio (`/fr/programme/term_genre_and_style=music` et `…=music+theatre`, paginé, sous-filtre rejet families/sound art) | ~105 concerts musique + opéra sur 14 mois |
| OPRL | ✅ opérationnel | HTML + cheerio (Drupal `/fr/concerts?date=YYYY-MM`, fenêtre roulante de ~3 mois, rejet `series-symphokids` + `series-dumonde`) | ~105 concerts symphoniques + chambre + récitals sur 14 mois |
| Opéra Royal de Wallonie | ✅ opérationnel | API JSON `/wp-json/orw/v1/calendar?saisons=ID`, parse HTML retourné (cartes WP), filtre strict sur les terms (Opéra/Ballet/Concert/Création/Spectacle uniquement) | ~80 représentations sur les saisons en cours |
| Grand Manège (Namur) | ✅ opérationnel | HTML + cheerio (`/fr/concerts/calendrier`, mois encodé dans `class="venue-YYYYMM"` de chaque carte) | ~115 concerts sur 14 mois |
| MARS (Mons) | ✅ opérationnel | HTML + cheerio (`/calendrier/YYYYMM` mois par mois, pré-filtre URL `/musique/` puis filtre fin sur sous-genre détail Classique / Musique d'aujourd'hui / Musique ancienne / Baroque / Lyrique) | ~17 concerts savants sur 14 mois |
| PBA Charleroi | ✅ opérationnel | HTML + cheerio (`/notre-saison/?category=classique` + `=lyrique` × saisons découvertes via `<select name="season">`) | ~20 concerts sur les saisons en cours |
| deSingel (Anvers) | ✅ opérationnel | API JSON Postgres-proxy `/api/data` (table `production__c` + `activity__c`, filtre `productiontypetext__c='Muziek'`). URL `systemurlfr__c` privilégié sur NL/EN pour le lien externe | ~180 représentations sur la saison |
| De Bijloke (Gand) | ✅ opérationnel | HTML + cheerio (`/nl/programma?page=N`, dataLayer Google Analytics dans la page détail pour genres + dates par représentation) | ~135 concerts sur 14 mois |
| Philharmonie Luxembourg | ✅ opérationnel | HTML + cheerio (`/fr/programme?month=M&page=N`, pagination mois × page, rejet des tags jeune public) | ~310 concerts sur 14 mois |
| Opéra de Lille | ✅ opérationnel | HTML + cheerio (`/saison-XX-XX/`, calendrier global de chaque page produit pour les dates) | ~15 concerts sur la fin de saison 25-26 |
| Atelier Lyrique de Tourcoing | ✅ opérationnel | HTML + cheerio (sous-pages catégorisées de la saison, date parsée du titre/slug) | ~10 concerts sur fin de saison |
| Maison de la Culture Tournai | ✅ opérationnel (placeholder) | HTML + cheerio Drupal (`/programme`, filtre discipline=musique + blacklist titre chanson/jazz/world) | 0 concerts savants détectés (la programmation Tournai est essentiellement chanson/théâtre/exposition) |
| Ferme du Biéreau (LLN) | ✅ opérationnel | HTML + cheerio Odoo (`/events`, filtre badge "Musique classique" + "Midzik") | ~2 Midzik chamber concerts visibles |
| Cultuurcentrum Hasselt (CCHA) | ✅ opérationnel (placeholder) | HTML + cheerio Peppered (même CMS que Bijloke), filtre strict Klassiek/Symfonisch/Kamermuziek/… | ~1 concert classique sur 28 productions (Hasselt n'est pas une place classique) |
| Triangel (Saint-Vith) | ✅ opérationnel | HTML + cheerio (`/evenements/`, CMS custom .NET propre). Filtre strict cat="Concert" + blacklist titre (Heino/Oberkrainer/Q-Revival/Musikverein/Brings) | ~8 concerts classiques sur 42 événements (CMIREB Violoncelle, BNO Romantik, Voces8, EUYWO, Primacanta, Scandinavian Night, Matinée-Konzert, Play-In). Cross-source dedup avec OBF : les concerts OBF au Triangel supersèdent leur version triangel.js |
| OstbelgienFestival (OBF) | ✅ opérationnel (scraper dédié, Joomla + JEM) | ~22 concerts saison mai-décembre 2026 répartis sur Triangel St-Vith + Eupen (Atelier, Jünglingshaus, Pfarrkirche, monuments) + Kelmis + obf-festival umbrella (Destillerie Radermacher, Kapelle St. Hubertus, Alter Schlachthof, Kloster Heidberg, IKOB, Brauerei Eifel, sentiers Eifel). Tagging festival obf-2026 |
| AMUZ (Anvers) | ✅ opérationnel (scraper dédié, WordPress + activity post type) | ~66 concerts/saison via `/wp-json/wp/v2/activity` paginé + détail HTML pour la date `.data h3/h4`. Filtre par activity_type (KEEP : Concert/Kamermuziek/Polyfonie/Vocaal/Instrumentaal/Klavier/Orkest/Zondag/Muziektheater). Reject titre pour les "Extern programma" non-classiques (Dotan, Lucky Star, Boekhandel, Marnixring, Flamenco). Tagging Laus Polyphoniae 2026 (21-29 août) |
| Concerts de Midi Liège (Société Royale ASBL) | ✅ opérationnel (placeholder en intersaison) | Scraper WordPress générique (heuristique articles/h-tags + date FR). Saison 2025-2026 terminée, saison 2026-2027 pas encore publiée → 0 concert ce run. Se réveillera automatiquement à la rentrée |
| Antwerp Symphony Orchestra (Salle Reine Elisabeth, Antwerpen) | ✅ opérationnel (scraper dédié) | HTML statique propre, version FR officielle paginée (`/fr/programma?page=N`, ~11 pages). ~60 concerts/saison à Salle Reine Elisabeth + AMUZ. Filtre rejet Lectures/Répétitions/Activités Amis/Concerts familial. Dédup cross-source avec AMUZ (ASO prime, ~9 doublons) |
| Reste : ONL Lille (Cloudflare 503), Opera Ballet Vlaanderen (Nuxt minifié), Muziekodroom (pop/rock, hors périmètre) | ⏸ reportés / hors périmètre | — | — |

### Pipeline

- Chaque scraper expose `async scrape<Source>()` qui retourne un tableau
  d'objets normalisés (schéma documenté ci-dessous).
- `scripts/aggregate.js` exécute toutes les sources en série, conserve
  les données précédentes pour une source qui plante (pas de perte de
  catalogue à cause d'une page momentanément KO), trie par date et
  écrit `data/concerts.json` (tableau pur, plus le wrapper de la Phase 1).
- `data/composers-reference.json` fournit la liste de référence
  (~115 entrées avec aliases) pour canoniser et matcher les compositeurs
  cités dans les programmes.
- `.github/workflows/scrape-nightly.yml` lance `node scripts/aggregate.js`,
  puis commit `data/concerts.json` si le diff est non vide. Cron à 04h UTC
  désactivé tant que tous les scrapers ne sont pas validés ; lancement
  manuel via l'onglet **Actions → Run workflow**.

### Schéma d'un concert

```json
{
  "id": "bozar-2026-06-15-mahler-symphonie-2",
  "source": "bozar",
  "venue_id": "bozar",
  "title": "Mahler — Symphonie n°2 'Résurrection'",
  "date": "2026-06-15",
  "time": "20:00",
  "url": "https://www.bozar.be/fr/calendrier/...",
  "composers": ["Mahler"],
  "performers": ["Belgian National Orchestra", "Hugh Wolff (direction)"],
  "program": "Mahler — Symphonie n°2",
  "price_min": 26,
  "price_max": 64,
  "cancelled": false,
  "scraped_at": "2026-05-09T04:00:00Z"
}
```

Champs obligatoires : `id`, `source`, `venue_id`, `title`, `date`, `url`.
Champs best-effort : `time`, `composers`, `performers`, `program`,
`price_min`, `price_max`. Si un champ n'est pas trouvable, `null` (pas
d'invention).

### Tester un scraper en local

```bash
npm install
npm run scrape:bozar      # exporte le résultat brut sur stdout
npm run scrape:monnaie    # idem pour La Monnaie
npm run scrape:flagey     # idem pour Flagey
npm run scrape:cgbrugge   # idem pour Concertgebouw Brugge
npm run scrape:oprl       # idem pour OPRL
npm run scrape:orw        # idem pour Opéra Royal de Wallonie
npm run scrape:gmanege    # idem pour Grand Manège (Namur)
npm run scrape:mars       # idem pour MARS (Mons)
npm run scrape:pba        # idem pour PBA Charleroi
npm run scrape:desingel   # idem pour deSingel (Anvers)
npm run scrape:bijloke    # idem pour De Bijloke (Gand)
npm run scrape:phillux    # idem pour Philharmonie Luxembourg
npm run scrape:opl        # idem pour Opéra de Lille
npm run scrape:tourcoing  # idem pour Atelier Lyrique de Tourcoing
npm run scrape:tournai    # idem pour Maison de la Culture Tournai
npm run scrape:biereau    # idem pour Ferme du Biéreau (LLN)
npm run scrape:ccha       # idem pour Cultuurcentrum Hasselt
npm run scrape:stavelot   # idem pour Festival de Stavelot
npm run scrape:silly      # idem pour Printemps Musical de Silly
npm run scrape:musiq3-bw  # idem pour Festival Musiq3 Brabant wallon
npm run scrape:nuits-septembre  # idem pour Les Nuits de Septembre (Liège)
npm run scrape:crb        # idem pour Conservatoire royal de Bruxelles
npm run scrape:kbr        # idem pour KBR — Bibliothèque royale de Belgique
npm run scrape:chapelle   # idem pour Chapelle Musicale Reine Elisabeth (Waterloo)
npm run scrape:arsenal-metz   # idem pour Arsenal Metz (Cité musicale-Metz)
npm run scrape:st-michel  # idem pour Festival Saint-Michel-en-Thiérache
npm run scrape:arts-au-carre  # idem pour Arts au Carré (ARTS² Mons)
npm run scrape:lille-pianos   # idem pour Lille Piano(s) Festival
npm run scrape:hardelot   # idem pour Midsummer Festival Hardelot
npm run scrape:triangel   # idem pour Triangel (Sankt-Vith)
npm run scrape:obf        # idem pour OstbelgienFestival
npm run scrape:amuz       # idem pour AMUZ (Anvers)
npm run scrape:midiliege  # idem pour Concerts de Midi Liège (Société Royale)
npm run scrape:antwerp-symphony  # idem pour Antwerp Symphony Orchestra
npm run scrape            # exécute aggregate.js → data/concerts.json
                          #  ↳ applique aussi les tags festivals.json
python3 -m http.server 8000   # voir le résultat sur localhost:8000
```

### Reste à faire

- [ ] 2 scrapers supplémentaires en attente (Phase 2.x bis) :
      - **Opera Ballet Vlaanderen** : Nuxt SSR avec performances dans
        une fermeture minifiée non triviale ; nécessite un parser Nuxt
      - **ONL Lille** : Cloudflare 503 systématique ; nécessite Playwright
- [ ] 1 source écartée : **Triangel** (Google Sites SPA, contenu invisible)
- [ ] 1 source hors périmètre : **Muziekodroom Hasselt** (pop/rock,
      pas de classique)
- [ ] Stratégie anti-doublons inter-sources (concerts en tournée)
- [ ] Activer le cron une fois 5+ sources stabilisées

## Phase 3 — Festivals

### Architecture anti-doublons

Les festivals classiques se déroulent souvent dans des venues **déjà
scrapées** (Klarafestival à Bozar/Flagey/Monnaie, Musiq3 à Flagey,
Festival Musical de Namur au Grand Manège…). Pour éviter de scraper
les mêmes concerts deux fois, on distingue deux stratégies :

**A. Tagging-only** (festival dans nos venues) — `data/festivals.json`
liste les festivals avec leurs venues + plage de dates. À l'agrégation,
chaque concert dont `(venue_id, date)` matche un festival reçoit un
champ `festival: "ID"` (ou `festivals: ["ID1","ID2"]` si plusieurs).
Aucun scraper dédié n'est nécessaire.

**B. Scraper dédié** (festival hors-circuit) — quand le festival se
joue dans des lieux non listés (églises, abbayes, châteaux), on
scrape directement et on attribue les concerts à un venue dédié
(ex. `stavelot-festival`). Le tag festival reste appliqué via
`festivals.json`.

| Festival | Stratégie | Couverture |
|---|---|---|
| Festival Musiq3 | A (tagging Flagey) | ~10-15 concerts auto-taggés en juin |
| Festival Musical de Namur | A (tagging Grand Manège) | ~15 concerts auto-taggés fin juin / juillet |
| Festival de Stavelot | B (scraper dédié) | ~13 concerts d'été dans 5 lieux stavelotais |
| Printemps Musical de Silly | B (scraper dédié) | ~15 concerts mars-novembre dans plusieurs lieux silliens |
| Festival Musiq3 Brabant wallon | B (scraper dédié) | 12 concerts fin sept-début oct dans 11 lieux du BW |
| Les Nuits de Septembre (Liège) | B (scraper dédié) + tagging OPRL | ~12 concerts musique ancienne en septembre-octobre |
| Ekinox (Mons + Charleroi) | A (tagging MARS + PBA) | 26 concerts auto-taggés début octobre |
| Festival Musicorum (MRBAB Bruxelles) | B (scraper dédié) | 48 concerts gratuits midis 12h15 juillet-août |
| Festival Midis-Minimes (Bruxelles) | B (scraper dédié) | 42 concerts gratuits midis 12h15 juillet-août (40e édition) |
| MA Festival Brugge | B (scraper dédié, version EN /en/programma — pas de FR officielle) + tagging Concertgebouw Brugge | ~24 concerts hors-Concertgebouw (églises, abbayes brugeoises) du 31 juillet au 9 août 2026 |
| Festival Les Voix Intimes (Tournai, Proquartetto) | B (scraper dédié) + tagging Maison de la Culture | 24e édition "Indivisible by Four" — saison 25-26 + Midis du Quatuor août 2026 (Chapelle de la Madeleine) |
| Conservatoire royal de Bruxelles (CRB) | scraper dédié | ~6 concerts publics par fenêtre rolling, dédoublonnage avec MIM + KBR |
| KBR — Bibliothèque royale de Belgique | scraper dédié (API Tribe Events) | ~5 événements musicaux : Trésors musicaux, Concert de midi, Polyphonies improvisées, Conte en balade |
| Chapelle Musicale Reine Elisabeth (Waterloo) | scraper dédié (WordPress, JSON-LD schema.org/Event par fiche) | ~50-65 concerts/an : récitals, marathons, MuCH Sundays, MuCH Surprise, Horizon, Artist Diploma, Garden Party, masterclasses publiques. Dédoublonnage avec MIM/Bozar/Flagey/Monnaie via `location.name` |
| Festival Contrastes (Tournai) | placeholder festival uniquement | Édition 2025 publiée (1 jour à Esplechin) ; édition 2026 annoncée 13 juin 2026 mais pas encore détaillée sur le site |
| Conservatoire de Tournai | venue placeholder | Pas d'agenda public exploitable sur conservatoire.tournai.be (Drupal sans rubrique événements) |
| Arsenal Metz (Cité musicale-Metz) | scraper dédié (Nuxt SSR paginé) | ~15 concerts/saison : symphoniques (ONL), récitals, musique de chambre, jazz acoustique. Filtre venue=Arsenal+Saint-Pierre-aux-Nonnains ; reject Exposition/Atelier |
| Festival de l'Abbaye de Saint-Michel-en-Thiérache | scraper dédié (Elementor headings parsing) | 12 concerts musique ancienne & baroque, 40e édition 5 dimanches juin-juillet 2026 (Monteverdi L'Orfeo, Bach Messe en Si, Jordi Savall, Concert de la Loge) |
| Lille Piano(s) Festival | scraper dédié (WordPress, headings h2-h6 par concert) | 23e édition 12-14 juin 2026, ~37 concerts répartis dans plusieurs lieux lillois (Auditorium ONL, Cathédrale Notre-Dame de la Treille, Théâtre du Casino Barrière, Gare Saint Sauveur, Conservatoire de Lille…) |
| Théâtre élisabéthain du Château d'Hardelot | scraper dédié (Drupal /agenda-6 paginé + JSON-LD détail) | ~10 concerts/opéras saison 2026 dont Midsummer Festival 10e édition fenêtre 20-27 juin (Acis Galatée Polyphème, Vivaldi Echos de Venise, Witch of Endor). Filtre rejet Théâtre/Visite/Conférence/Spectacle |
| Opéra-Théâtre Metz Métropole | venue placeholder | Productions JS-rendered sur globalflexit CMS ; billetterie externe themisweb (HTML statique vide) |
| Grand Théâtre de Luxembourg | venue placeholder | theater.lu liste multi-venues sans accès saison complète ; filtre `data-venue=grand-theatre` ne capture que 12 événements actuels (danse+théâtre, pas d'opéra visible sur la fenêtre courante) |
| Conservatoire royal de Liège (CRLg) | venue placeholder | site institutionnel sans agenda exploitable (annonces sous forme de news ponctuelles) |
| Arts² Mons | scraper dédié (Arts au Carré, WordPress) | ~5-10 concerts publics/mois via /events/categories/musique-fr/ (CONCERT², LES MIDIS D'ARTS², Festival Studio PBA). Filtre rejet ÉVALUATION²/AUDITION/jurys |
| IMEP Namur | venue placeholder | Cloudflare bloque tous les sous-paths (/evenements, /news, /agenda → 403) |

### À venir

- [ ] Klarafestival 2027 (mars 2027 — dates à confirmer)
- [ ] Ars Musica 2026 (festival contemporain Bruxelles, novembre-décembre)
- [ ] Festival van Vlaanderen Brugge / MA Festival (site en migration)
- [ ] Festival Adolphe Sax (Dinant)
- [ ] Festivals Mons-Charleroi-Hainaut (via Festivals de Wallonie)

## Phase 4 — Élargissements

- [ ] Cercle 2 : conservatoires, séries de chambre régionales
- [ ] Newsletter : envoi hebdomadaire des concerts du week-end
- [ ] Flux RSS / iCal par ville et par compositeur

---

## Développement local

```bash
# Pas de build : il suffit de servir le dossier en HTTP statique
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

Ne pas ouvrir `index.html` directement avec `file://` — les `fetch()`
des fichiers JSON échoueront.

---

## Déploiement Vercel

Aucune configuration nécessaire. Vercel détecte le dossier comme un site
statique et publie `index.html` à la racine.

```bash
# via la CLI (optionnel)
npm i -g vercel
vercel deploy             # preview
vercel deploy --prod      # production
```

Ou par drag & drop sur https://vercel.com/new après avoir poussé le repo
sur GitHub.

---

## Crédits

- **Direction éditoriale** : Pierre-Jean Tribot — Crescendo Magazine
- **Tuiles cartographiques** : © OpenStreetMap contributors, © CARTO
- **Typographie** : Cormorant Garamond, Inter (Google Fonts)
