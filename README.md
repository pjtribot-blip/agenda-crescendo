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
│   └── scrape-weekly.yml   # Phase 2 — cron hebdomadaire (dimanche 03h UTC)
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
- **Icônes web** : favicon multi-résolution (.ico 16/32/48 + PNG
  16/32), apple-touch-icon 180×180, android-chrome 192/512, et
  `site.webmanifest` (PWA installable). Génération à partir d'un
  master `favicon.png` 512×512 via `node scripts/generate-favicons.js`.

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
| Theater aan het Vrijthof (Maastricht — Pays-Bas) | ✅ opérationnel (scraper dédié) | Premier venue NL de l'agenda. Concrete CMS, URLs encodant `/voorstellingen/{cat}/{slug}/DD-MM-YYYY-HH-MM`. Filtre par catégorie URL : KEEP klassiek-* + opera, exception ballets de répertoire (Notenkraker, Zwanenmeer, Nationale Ballet, NDT, Introdans…) ; REJECT toneel/cabaret/musical/familie/theaterconcert. Sous-filtre titre rejet Harmonie/Fanfare/Vastelaovend/André Rieu (Limburg = forte tradition harmonie). Saison 26-27 partiellement publiée → 1 concert capté au commit (PhilXmas Philzuid 20/12), croissance attendue |
| Automne Musical de Spa | ⏸ placeholder | Site automnemusical.com resté sur édition 2024. Édition 2026 annoncée sans dates publiées. À ré-explorer juillet-août 2026 |
| Festival de Laon | ✅ opérationnel (placeholder en intersaison) | Scraper WordPress/Elementor (même CMS et webmaster Maxime Delalande que Festival St-Michel-en-Thiérache). Hub `/programme-billetterie/` + pages détail `{jour}-{DD}-{mois}-{YYYY}/`. 38e édition automne 2026 pas encore publiée → 0 concert ce run. Tagging festival-laon-2026 prêt (fenêtre 10/09→11/10). Partenariat Orchestre Philharmonique de Radio France |
| Opera Ballet Vlaanderen | ✅ intégration manuelle (dossier de presse) | Site obv.be utilise Nuxt avec données obfusquées impossibles à scraper. Saison 26-27 encodée à la main depuis le dossier de presse officiel (24 avril 2026, pages 35-37) dans `data/manual-sources/obv-26-27.json`. 33 productions × ~4-10 représentations = ~135 dates ; ~14 venues OBV (Opera Antwerpen, Capitole Gent, Stadsschouwburg Antwerpen, NTGent, De Vooruit, Theater 't Eilandje…). Mise à jour annuelle au lancement de la nouvelle saison |
| Wilde Westen (Kortrijk) | ✅ opérationnel | Centre de musique pointu, accueille le volet courtraisien du Festival van Vlaanderen. HTML + JSON-LD schema.org/Event par fiche. Filtre serveur `?genres[]=klassiek-jazz&genres[]=geluidskunst` puis title-reject (DJ set, party, workshop). ~5 concerts au 12 mai 2026 (Terry Riley In C, Nenia Revue Blanche, Sonic City 2026, Pool of Sound, Tuur Florizoone) |
| Concerts du Printemps de Val-Dieu (Aubel) | ✅ opérationnel | Festival annuel mai-juin à la Basilique de l'Abbaye de Val-Dieu. HTML statique propre (WordPress + Avia/Enfold). Parsing direct des `<h3>` au format `DD-MM-YYYY – Artiste, HHh`. 58e édition 2026 (22/05 → 19/06) : 5 concerts vendredi à 20h. Tagging festival `concerts-printemps-valdieu-2026` |
| Espace Senghor (Etterbeek) | ✅ opérationnel | Centre culturel pluridisciplinaire WordPress avec REST API. Filtre par taxonomy `field` (`104,130,132,318,483` = contemporaine/acousmatique/création/classique/musique) puis skip jazz métissé/musiques du monde/théâtre/danse/jeune public. Date d'événement absente de l'API publique → fetch fiche détail `/project/{slug}/` pour bloc `.sl-date` format `(LU\|MA\|...)\sDD\sMOIS HH:MM`. Année déduite de la saison (taxonomy `season`, ex. "2025-2026") |
| Philharmonie Zuid-Nederland (Philzuid) | ✅ opérationnel | Orchestre symphonique régional du sud des Pays-Bas. Site philzuid.nl rendu Vue.js + recherche Algolia côté client. Scraper interroge l'API Algolia REST directe (`/1/indexes/Events/query`) avec App ID `IP15U4XWIC` + API key publique + header `Referer: https://philzuid.nl/` obligatoire (sans ça → 403). FacetFilter `locationCity:Maastricht` côté serveur (Maastricht = exception transfrontalière périmètre Crescendo, Eindhoven/Heerlen/Den Bosch hors-périmètre). Filtre titre `vastelaovend\|carnaval` (cohérence Vrijthof). Dédup cross-source `philzuid` × `vrijthof` au venue `vrijthof-maastricht` — Philzuid prime |
| Cathedralis Bruxellensis (Cathédrale Saints-Michel-et-Gudule) | ✅ opérationnel | Cathédrale de Bruxelles. WordPress + plugin MEC (Modern Events Calendar). Archive `/mec-category/concerts/` expose des blocs JSON-LD `@type:Event` (heures décalées +2h par bug MEC : on parse l'heure depuis le titre `DD/MM/YYYY – HH:MM`, fallback startDate −2h, time=null si durée > 6h). Filtre éditorial : skip carillons festifs (Te Deum, Saint-Michel, Fête du Roi), fanfares amateur (Sainte Cécile d'Evere), vêpres liturgiques, messes solennelles, conférences de carême, interventions pastorales. ~4 concerts retenus sur la fenêtre observée (Currende & Bart Jacobs, Nuit du chant et de l'orgue, Le Messie de Haendel, chorale Cranleigh) |
| Orchestre National de Lille (ONL) | ✅ intégration manuelle (dossier de presse cinquantenaire) | Saison 26-27 encodée dans `data/manual-sources/onl-26-27.json`. 43 productions × ~1-3 dates = ~75 représentations. Lieux : Nouveau Siècle (siège), tournée régionale (Somain, Seclin, Valenciennes, Dainville, Carvin, Hem, Dunkerque, Mouchin, Saint-Amand, Gravelines), transfrontalière (Concertgebouw Bruges, De Spil Roulers, Philharmonie de Paris), festivals (Festival de La Chaise-Dieu). Couvre aussi les 11 dates Verdi *Otello* + Ermonela Jaho à l'Opéra de Lille (co-production marquée, opl scraper ne les capte pas). Productions exclues (3 Concerts Mystère, Belles Sorties non datées, OPUS/OMJ pédagogiques, 9 scolaires, ~30 péri-concert) documentées dans `excluded_concerts` du JSON |
| Reste : ONL Lille (Cloudflare 503), Muziekodroom (pop/rock, hors périmètre) | ⏸ reportés / hors périmètre | — | — |

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
- `scripts/utils/concert-classifier.js` classe chaque concert en 6
  catégories éditoriales (Phase 3.33) : opera, symphonique,
  chambre-recital, baroque-ancienne, contemporaine, hors-categorie.
  Cascade priorisée (opera prime, baroque suit selon ensemble période-
  instruments, contemporaine selon création/composers post-1950,
  symphonique selon orchestre, chambre selon quatuor/récital, fallback
  era-based + venue récital-friendly + blacklist artistes jazz/world).
  La méthode et les arbitrages éditoriaux sont détaillés dans le module
  source. Le champ `category` est calculé à l'agrégation et persisté
  dans `data/concerts.json`. La page Stats expose le panorama Belgique
  par catégorie (top venues / compositeurs / interprètes / distribution
  mensuelle pour chacune des 6 catégories).
- `.github/workflows/scrape-weekly.yml` lance `node scripts/aggregate.js`,
  puis commit `data/concerts.json` si le diff est non vide. Cron
  hebdomadaire **dimanche 03h UTC** (04h Bruxelles l'hiver, 05h l'été) —
  les saisons classiques se publient 2-4 fois par an, donc inutile de
  scraper tous les jours. Déclenchement manuel à la demande via
  l'onglet **Actions → Weekly scrape → Run workflow** (ou
  `gh workflow run scrape-weekly.yml`) quand une saison majeure est
  publiée. Le commit + push intègre un retry avec `git rebase -X ours`
  pour gérer les rares conflits sur `data/concerts.json` quand un push
  humain arrive pendant le scrape.

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
  "scraped_at": "2026-05-09T04:00:00Z",
  "category": "symphonique"
}
```

Champs obligatoires : `id`, `source`, `venue_id`, `title`, `date`, `url`.
Champs best-effort : `time`, `composers`, `performers`, `program`,
`price_min`, `price_max`. Si un champ n'est pas trouvable, `null` (pas
d'invention).
Champ dérivé (Phase 3.33) : `category` (`opera` | `symphonique` |
`chambre-recital` | `baroque-ancienne` | `contemporaine` |
`hors-categorie`) — calculé à l'agrégation par
`scripts/utils/concert-classifier.js`.

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
npm run scrape:vrijthof-maastricht  # idem pour Theater aan het Vrijthof (Maastricht, NL)
npm run scrape:festival-laon  # idem pour Festival de Laon (38e éd. automne 2026)
npm run scrape:obv-manual # charge data/manual-sources/obv-*.json (Opera Ballet Vlaanderen)
npm run scrape:onl-manual # charge data/manual-sources/onl-*.json (Orchestre National de Lille)
npm run scrape:wildewesten # idem pour Wilde Westen (Kortrijk)
npm run scrape:valdieu    # idem pour Concerts du Printemps de Val-Dieu (Aubel)
npm run scrape:senghor    # idem pour Espace Senghor (Etterbeek, Bruxelles)
npm run scrape:philzuid   # idem pour Philzuid (Philharmonie Zuid-Nederland, Maastricht)
npm run scrape:cathedralis # idem pour Cathedralis Bruxellensis (Cathédrale Saints-Michel-et-Gudule)
npm run scrape            # exécute aggregate.js → data/concerts.json
                          #  ↳ applique aussi les tags festivals.json
python3 -m http.server 8000   # voir le résultat sur localhost:8000
```

### Reste à faire

- [ ] **Phase 3.20 — Refonte scraper opera-lille (dette technique,
      non prioritaire)** : la saison 26-27 d'Opéra de Lille n'est
      plus captée par le scraper actuel. `/saison-26-27/` redirige
      vers une JPEG (flyer de saison), donc le scan saison renvoie 0
      production 26-27. Les fiches `/spectacle/{slug}/` existent et
      contiennent les dates dans un **nouveau format HTML** :
      `<div class="spectacle-details-horaires">` avec 3 spans par
      date (`spectacle-details-date`, `…-heure`, `…-statut`).
      L'ancien parser cherche encore les conteneurs
      `calendrier-YYYY-MM-DD` qui ne représentent plus les dates
      du spectacle mais un calendrier global de la salle. À refaire :
      source de la liste = `/programmation/` ou sitemap (au lieu des
      pages de saison), parser le nouveau bloc `.spectacle-details-
      horaires`. Vérifier ensuite la dédup ONL × OPL (11 dates Otello
      + Ermonela Jaho sont pour l'instant côté ONL avec
      `co_production: "opera-de-lille"` — voir Phase 3.19).
- [ ] 1 source écartée : **Muziekodroom Hasselt** (pop/rock,
      pas de classique)
- [ ] Stratégie anti-doublons inter-sources (concerts en tournée)
      — partiellement traitée via le mécanisme `dedup-cross`
      (Phase 3.12 OBF×Triangel, Phase 3.15 ASO×AMUZ)

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
- [ ] **Festival 20·21** (Louvain, Brabant flamand) —
      https://www.festival2021.be/nl/agenda
      Volet musiques XXe/XXIe du Festival van Vlaanderen Vlaams-
      Brabant. Direction Pieter Bergé / Maarten Beirens. Temps
      forts : NOVECENTO, TRANSIT, Festival+ itinérant. Période
      fin septembre → fin octobre. À scraper quand la
      programmation 2026 sera publiée (page actuellement vide).
- [ ] **Phase 3.22 — Bozar saison 26-27** (à déclencher semaine
      du 19 mai 2026). Bozar publie sa saison complète 26-27
      la semaine prochaine. État des lieux au 12 mai 2026 :
      `scripts/scrapers/bozar.js` existe et fonctionne, 48
      concerts captés, fenêtre 13/05/2026 → 05/05/2027 (donc
      saison 26-27 déjà partiellement couverte par anticipation).
      Stratégie : `/fr/calendar?section=527&from=…&to=…&page=N`
      paginé + filtre taxonomique (keep classique/ancienne/
      récital/chambre/orchestres ; reject jazz/global/électro)
      + visite fiche détail pour date+heure+programme+composers.
      **À faire** : lancer un test après publication officielle
      pour valider que la pagination + le filtre récupèrent
      bien la masse complète de la nouvelle saison. Refonte
      seulement si le format HTML a changé (cf. cas opera-lille
      Phase 3.20 où `/saison-26-27/` redirigeait vers une JPEG
      et le bloc dates avait été restructuré).
- [ ] **Carte — labels en français** (Phase ultérieure, non
      prioritaire). Fond actuel CartoDB Positron : rendu gris épuré
      idéal pour mettre en valeur les marqueurs concerts, mais
      labels en anglais (Brussels, Antwerp, Upper France, Greater
      East, Limburg…). Alternative envisagée : **Stadia Maps
      Alidade Smooth** avec paramètre `?lang=fr`. Nécessite
      création d'un compte Stadia Maps gratuit (~5 min) et ajout
      d'une clé API dans le tileLayer. Quota gratuit 200 000
      tuiles/mois — largement suffisant pour le trafic agenda.
      Documentation : https://docs.stadiamaps.com/themes/. À
      traiter quand temps disponible.

## Phase 4 — Élargissements et outillage éditorial

- [x] **Statistiques de l'agenda** (Phase 4.1) — page UI accessible
      depuis l'en-tête (📊 Statistiques) + script CLI
      `npm run stats-report` qui génère `reports/stats-YYYY-MM-DD.md`
      utilisable pour l'article fondateur de Crescendo Magazine.
      6 blocs : couverture globale, géographie, temporalité,
      compositeurs (top 20 + compositrices + Belges), festivals,
      qualité éditoriale.
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
