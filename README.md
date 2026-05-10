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
| deSingel (Anvers) | ✅ opérationnel | API JSON Postgres-proxy `/api/data` (table `production__c` + `activity__c`, filtre `productiontypetext__c='Muziek'`) | ~180 représentations sur la saison |
| De Bijloke (Gand) | ✅ opérationnel | HTML + cheerio (`/nl/programma?page=N`, dataLayer Google Analytics dans la page détail pour genres + dates par représentation) | ~135 concerts sur 14 mois |
| Philharmonie Luxembourg | ✅ opérationnel | HTML + cheerio (`/fr/programme?month=M&page=N`, pagination mois × page, rejet des tags jeune public) | ~310 concerts sur 14 mois |
| Opéra de Lille | ✅ opérationnel | HTML + cheerio (`/saison-XX-XX/`, calendrier global de chaque page produit pour les dates) | ~15 concerts sur la fin de saison 25-26 |
| Atelier Lyrique de Tourcoing | ✅ opérationnel | HTML + cheerio (sous-pages catégorisées de la saison, date parsée du titre/slug) | ~10 concerts sur fin de saison |
| Les 4 autres | ⏳ à venir | À choisir source par source | — |

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
npm run scrape            # exécute aggregate.js → data/concerts.json
python3 -m http.server 8000   # voir le résultat sur localhost:8000
```

### Reste à faire

- [ ] 4 scrapers supplémentaires (priorité : Opera Ballet Vlaanderen,
      ONL Lille — bloqué Cloudflare 503, Maison de la Culture Tournai,
      Triangel, Ferme du Biéreau, Cultuurcentrum Hasselt, Muziekodroom)
- [ ] Stratégie anti-doublons inter-sources (concerts en tournée)
- [ ] Activer le cron une fois 5+ sources stabilisées

## Phase 3 — Élargissements

- [ ] Cercle 2 : conservatoires, festivals d'été, séries de chambre
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
