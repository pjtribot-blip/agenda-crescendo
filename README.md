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

## Phase 2 — Scrapers (à venir)

- [ ] Un scraper Node.js par source (`scripts/scrapers/<source>.js`)
- [ ] Script d'agrégation `scripts/aggregate.js` → `data/concerts.json`
- [ ] GitHub Actions quotidienne à 04h UTC (`scrape-nightly.yml`)
- [ ] Normalisation des champs : titre, date ISO, heure, ensemble, chef,
      solistes, compositeurs, programme, URL d'origine
- [ ] Stratégie anti-doublons (Bach mentionné 17 fois ≠ 17 concerts)

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
