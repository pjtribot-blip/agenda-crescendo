// Classification d'un concert en 6 catégories éditoriales :
//   opera | symphonique | chambre-recital | baroque-ancienne |
//   contemporaine | hors-categorie
//
// Phase 3.33 — cascade priorisée. Le premier match gagne. Arbitrages
// utilisateur figés dans les patterns ci-dessous (ex. Bach par OPRL =
// symphonique, Vox Luminis joue Brahms = baroque, ballet OBV = opéra).

import { matchComposersFromText } from './composer-filter.js';

export const CATEGORIES = [
  'opera', 'symphonique', 'chambre-recital',
  'baroque-ancienne', 'contemporaine', 'hors-categorie',
];

// ---------------------------------------------------------------
// Enrichissement composers (Option C round 3)
// ---------------------------------------------------------------
// Compositeurs pré-1750 (baroque & renaissance). Utilisé pour le
// fallback era-based.
const BAROQUE_OR_EARLY_COMPOSERS = new Set([
  'Bach', 'C.P.E. Bach', 'Vivaldi', 'Haendel', 'Monteverdi', 'Lully',
  'Purcell', 'Couperin', 'Rameau', 'Charpentier', 'Schütz', 'Buxtehude',
  'Telemann', 'Corelli', 'Albinoni', 'Scarlatti', 'Pachelbel', 'Frescobaldi',
  'Cabezón', 'Gabrieli', 'des Prez', 'Josquin', 'di Lasso', 'Lassus',
  'Palestrina', 'Victoria', 'Tallis', 'Byrd', 'Dowland', 'Marenzio',
  'Gesualdo', 'Pergolesi', 'Carissimi', 'Steffani', 'Cavalli', 'Cesti',
  'Hasse', 'Caldara', 'Marais', 'Lalande', 'Allegri',
]);

// Alias phonétiques NL/DE/EN — UNIQUEMENT pour la classification, NE
// PAS injecter dans composers-reference.json (la règle word-boundary
// du Phase 3.31 sur le pipeline aggregate doit rester stable).
const PHONETIC_ALIASES = {
  'Tsjajkovski': 'Tchaïkovski',
  'Tsjaikovski': 'Tchaïkovski',
  'Tchaikovsky': 'Tchaïkovski',
  'Sjostakovitsj': 'Chostakovitch',
  'Shostakovich': 'Chostakovitch',
  'Strawinsky': 'Stravinsky',
  'Sjoebert': 'Schubert',
  'Sjoemann': 'Schumann',
  'Händel': 'Haendel',
  'Handel': 'Haendel',
  'Mussorgsky': 'Moussorgski',
  'Moussorgsky': 'Moussorgski',
  'Rachmaninoff': 'Rachmaninov',
  'Prokofjev': 'Prokofiev',
  'Glasunow': 'Glazounov',
  // Compositeurs contemporains cités par nom de famille seul dans les
  // titres NL/EN. composers-reference.json ne liste que la forme
  // multi-mots (Philip Glass, Steve Reich) → on injecte le mononyme
  // ici (classifier-only, pas de risque de pollution pipeline aggregate).
  'Glass': 'Glass',
  'Reich': 'Reich',
  'Feldman': 'Feldman',
  'Stockhausen': 'Stockhausen',
};

// Œuvres iconiques — quand le titre cite l'œuvre sans nommer le
// compositeur (ex. "Brandenburg", "Goldberg"), on injecte le canonical.
// Skip si un autre composer est déjà explicite dans le concert.
const ICONIC_WORKS = [
  { pattern: /\bbrandenburg(s|se|sche|ois)?\b/i, composer: 'Bach' },
  { pattern: /\bgoldberg(s|se)?\b/i, composer: 'Bach' },
  { pattern: /\bcantate?s?\s*(bwv|n[°o]|number)\s*\d/i, composer: 'Bach' },
  { pattern: /\bmessias?\b|\bmessiah\b/i, composer: 'Haendel' },
  { pattern: /\bwater music\b|\bwassermusik\b/i, composer: 'Haendel' },
  { pattern: /\bvier(?:jaar)?getijden\b|\bquatre saisons?\b|\bfour seasons?\b/i, composer: 'Vivaldi' },
  { pattern: /\bcarmina burana\b/i, composer: 'Orff' },
  { pattern: /\bbol[ée]ro\b/i, composer: 'Ravel' },
  { pattern: /\ble sacre\b|\brite of spring\b|\bsacre du printemps\b/i, composer: 'Stravinsky' },
  { pattern: /\bpictures at an exhibition\b|\btableaux d['']une exposition\b/i, composer: 'Moussorgski' },
  { pattern: /\bnutcracker\b|\bcasse[- ]noisette\b|\bnotenkraker\b/i, composer: 'Tchaïkovski' },
];

// Blacklist artistes non-classiques (jazz, world, variétés). Utilisé
// par Option D round 3 pour éviter le fallback chambre-récital
// pour ces concerts (DeSingel jazz programme régulièrement).
const KNOWN_NON_CLASSICAL_ARTISTS = [
  // Jazz
  'dee dee bridgewater', 'helen sung', 'john scofield', 'avishai cohen',
  'sylvain rifflet', 'brad mehldau', 'keith jarrett', 'chick corea',
  'stéphane galland', 'aka moon', 'mélanie de biasio', 'robin verheyen',
  'octurn', 'helmut lipsky', 'mixmonk', 'mix monk',
  'cécile mclorin salvant', 'cecile mclorin',
  'tigran hamasyan', 'esperanza spalding', 'kamasi washington',
  'snarky puppy', 'shai maestro',
  // World
  'goran bregović', 'buena vista social club', 'tinariwen',
  // Variétés
  'stromae', 'angèle', 'tamino',
];

// ---------------------------------------------------------------
// Règle 0 — hors-catégorie hard signals
// ---------------------------------------------------------------
const HORS_CATEGORIE_PATTERNS = [
  /\bcin[ée]-?concert\b/i,
  /\bbande originale\b/i,
  /\bcom[ée]die musicale\b/i,
  /\bmusiques?\s+du\s+monde\b/i,
  /\btango argentin\b/i,
  /\bfado\b/i,
  /\bflamenco\b/i,
  /\bDJ\s+set\b/i,
  /\bsoundtrack\b/i,
];

// ---------------------------------------------------------------
// Règle 1 — opéra
// ---------------------------------------------------------------
// Sources dont la programmation est >80% opéra (incl. ballet pour OBV
// per arbitrage utilisateur). On défaut-classe opéra sauf si le titre
// indique explicitement un autre format (récital, symphonique, hommage
// à un compositeur, concert du Nouvel An, apéritief-concert, etc.).
// Phase 3.31 round 2 — exclusions élargies pour Monnaie/OBV qui hébergent
// aussi des concerts symphoniques et hommages contemporains.
const OPERA_SOURCES = new Set(['orw', 'opl', 'obv', 'monnaie']);
// Phase 3.38 — OPERA_HARD_NEGATIVE s'applique à LA FOIS au source-default
// ET à title-match (un titre qui matche \bopéra\b dans le program mais
// dont le titre lui-même contient "Concert d'ouverture" ne doit PAS être
// classé opéra). C'est ce qui filtrait avant uniquement le source-default.
const OPERA_HARD_NEGATIVE = new RegExp([
  // Phase 3.31 round 2 (origine source-default)
  /\br[ée]cital\b/.source,
  /\bconcert\s+de\s+midi\b/.source,
  /\bconcert\s+symphonique\b/.source,
  /\bconcert\s+de\s+chambre\b/.source,
  /\borchestre\b/.source,
  /\bnew\s+year\b|\bnouvel\s+an\b/.source,
  /\bhommage\b/.source,
  /\bsymphonique\b/.source,
  /\bconcert\s+(de\s+)?fin\s+d['']?ann[ée]e\b/.source,
  /\bap[ée]ro|aperitief|ap[ée]ritief/.source,
  // Phase 3.38 — extensions audit opera
  /\bmusica\s+da\s+camera\b/.source,
  /\bmusique\s+de\s+chambre\b/.source,
  /\bconcert\s+d['']?ouverture\b/.source,
  /\bconcert\s+de\s+cl[ôo]ture\b/.source,
  /\bconcertini\b/.source,
  /\bs[ée]r[ée]nade\b/.source,
  /\bch[œo]ur\b.{0,30}\bkoor\b/.source,                // chœur ... koor (Monnaie)
  /\bcomposant[ee]?n?\s*dag\b/.source,                 // Componistendag (déjà OK ailleurs)
].join('|'), 'i');

// Alias rétro-compat : utilisé seulement via la cascade ci-dessous.
const OPERA_SOURCE_EXCLUSIONS = OPERA_HARD_NEGATIVE;

const OPERA_TITLE_PATTERNS = [
  // Phase 3.38 — `\bmise en scène\b` retiré (trop générique, matchait des
  // descriptifs de présentation/installation type "Les Saisons dansées",
  // "Chasing Rainbows" de Lea Desandre, etc.). Remplacé par 3 patterns
  // qui réservent l'opéra à un contexte vraiment opératique.
  /\bop[ée]ra\b/i, /\bopera\b/i,
  /\bversion\s+(de\s+)?concert\b/i,
  /\bdrame\s+lyrique\b/i,
  /\btrag[ée]die\s+lyrique\b/i,
  /\bop[ée]ra\s+en\s+\d+\s+actes?\b/i,
  /\bop[ée]ra[- ]ballet\b/i,
  /\bop[ée]ra-comique\b/i,
  /\bsinger\s*spiel\b|\bsingspiel\b/i,
  // Italiens canon
  /\botello\b/i, /\bfalstaff\b/i, /\baida\b/i, /\btosca\b/i, /\bboh[èe]me\b/i,
  /\btraviata\b/i, /\brigoletto\b/i, /\bnorma\b/i, /\blucia di lammermoor\b/i,
  /\bnabucco\b/i, /\bmacbeth\b/i, /\btrovatore\b/i, /\bdon carlo[s]?\b/i,
  /\bsimon boccanegra\b/i, /\bcavalleria rusticana\b/i, /\bpagliacci\b/i,
  /\bmadame butterfly\b/i, /\bturandot\b/i, /\borfeo\b/i, /\bbarbier de s[ée]ville\b/i,
  // Mozart
  /\bdon giovanni\b/i, /\bnozze di figaro\b/i, /\b(le )?mariage de figaro\b/i,
  /\bzauberfl[öo]te\b/i, /\bfl[ûu]te enchant[ée]e\b/i, /\bcos[ìi] fan tutte\b/i,
  // Allemand / Wagner / Strauss
  /\bfidelio\b/i, /\btannh[äa]user\b/i, /\bparsifal\b/i, /\blohengrin\b/i,
  /\btristan\b/i, /\bg[öo]tterd[äa]mmerung\b/i, /\bcr[ée]puscule des dieux\b/i,
  /\b(la )?walkyrie\b/i, /\bsiegfried\b/i, /\brheingold\b/i, /\bma[îi]tres chanteurs\b/i,
  /\bsalom[ée]\b/i, /\belektra\b/i, /\bchevalier [àa] la rose\b/i,
  /\brosenkavalier\b/i, /\barabella\b/i, /\bariadne auf naxos\b/i,
  // Français
  /\bp[ée]ll[ée]as et m[ée]lisande\b/i, /\bcarmen\b/i, /\bfaust\b/i, /\bmanon\b/i,
  /\brom[ée]o et juliette\b/i, /\bhamlet\b/i, /\bles troyens\b/i,
  /\bdamnation de faust\b/i, /\bp[ée]n[ée]lope\b/i, /\bbarbe[- ]bleue\b/i,
  /\bl'heure espagnole\b/i, /\bl'enfant et les sortil[èe]ges\b/i,
  /\bdialogues des carm[ée]lites\b/i, /\bsaint fran[çc]ois d'assise\b/i,
  // Russes
  /\bboris godunov\b/i, /\beug[èe]ne on[ée]guine\b/i, /\bdame de pique\b/i,
  /\bpikovaya\b/i, /\bkhovanchtchina\b/i,
  // Modernes / contemporain
  /\bwozzeck\b/i, /\blulu\b/i,
  /\byvonne princesse de bourgogne\b/i, /\blessons in love and violence\b/i,
  /\bmar[íi]a de buenos aires\b/i, /\bmonsieur v[ée]nus\b/i,
  // Phase 3.38 — opéras baroques français (Rameau, Lully, Marais, Charpentier)
  /\bbor[ée]ades\b/i, /\bplat[ée]e\b/i, /\bdardanus\b/i, /\bzoroastre\b/i,
  /\bhippolyte\s+et\s+aricie\b/i, /\bcastor\s+et\s+pollux\b/i,
  /\bles\s+indes\s+galantes\b/i, /\bnaissance\s+d['']?osiris\b/i,
  /\barmide\b/i, /\batys\b/i, /\bpers[ée]e\b/i, /\bisis\b/i,
  /\bphaeton\b/i, /\balceste\b/i, /\bproserpine\b/i, /\bb[ée]ll[ée]rophon\b/i,
  /\bacis\s+et\s+galat[ée]e\b/i, /\bm[ée]d[ée]e\b/i,
  // Haendel (déjà partiel)
  /\bariodante\b/i, /\balcina\b/i, /\bgiulio\s+cesare\b/i, /\brinaldo\b/i,
  /\bserse\b/i, /\bxerxes\b/i, /\btamerlano\b/i, /\borlando\b/i,
  /\bsemele\b/i, /\bjephtha\b/i, /\btheodora\b/i,
  // Cherubini, Gluck, Spohr…
  /\biphig[ée]nie\b/i,
];

// Phase 3.38 — règle ballet hors maison lyrique
// Si le titre contient "ballet" / "dansé(e)(s)" / "chorégraphie" ET que
// la source N'EST PAS une maison lyrique → hors-catégorie. Les ballets
// produits par OBV / La Monnaie / ORW / OPL restent en opera (décision
// éditoriale validée). Un ballet dans une salle généraliste type
// Grand Manège tombe en hors-catégorie (cas "Les Saisons Dansées").
const BALLET_HORS_LYRIQUE = /\bballet\b|\bdans[ée]ées?\b|\bdans[ée]\b|\bch[ôo]r[ée]graphi/iu;

// ---------------------------------------------------------------
// Règle 2 — baroque & ancienne (basé sur ENSEMBLE)
// ---------------------------------------------------------------
const BAROQUE_SOURCES = new Set(['amuz', 'st-michel', 'ma-festival']);
const BAROQUE_FESTIVAL_IDS = new Set([
  'laus-polyphoniae-2026', 'ma-festival-2026', 'st-michel-thierache-2026',
]);
// IMPORTANT — Vlaams Radiokoor NE FIGURE PAS ici : c'est un chœur qui
// joue baroque ET romantique/contemporain. Cas par cas via composers
// (laisser le classifier descendre vers symphonique/contemporaine selon
// le programme).
const BAROQUE_ENSEMBLES = [
  // BE
  'vox luminis', 'anima eterna brugge', 'anima eterna', 'les muffatti', 'il gardellino',
  'capella pratensis', 'huelgas ensemble', 'ricercar consort', 'les agrémens',
  'collegium vocale gent', 'collegium vocale', 'la petite bande', "b'rock",
  "le concert d'anvers", 'scherzi musicali', 'capella mariana', 'cantando admont',
  'currende', 'cappella sancti michaelis', 'hathor consort', 'klein wien orkest',
  'le banquet céleste', 'graindelavoix', 'cantatrix', 'utopia ensemble',
  'inalto', 'in alto', 'cantus firmus belgica', 'bach society',
  // Phase 3.38 — ensembles baroques régulièrement programmés en BE
  // (vus dans les régressions audit opera : a nocte temporis avec
  // Reinoud Van Mechelen, Cappella Amsterdam avec Daniel Reuss).
  'a nocte temporis', 'reinoud van mechelen', 'cappella amsterdam',
  // International fréquents en BE
  'akademie für alte musik', 'concerto köln', 'le concert lorrain',
  'le concert de la loge', 'café zimmermann', 'les arts florissants',
  'capella mediterranea', 'pygmalion', "le concert d'astrée",
  'le concert spirituel', 'concert spirituel',
  'concerto italiano', 'english concert', 'academy of ancient music', 'tafelmusik',
  'tallis scholars', 'gesualdo six', 'stile antico', 'la sfera armoniosa',
  'la cetra', 'bach collegium japan', 'jordi savall', 'hespèrion xxi',
  'le poème harmonique', 'les talens lyriques', 'la chambre philharmonique',
  "apollo's fire", 'freiburger barockorchester', 'mahan esfahani',
  'rinaldo alessandrini',
  // Orchestre de période-instruments même répertoire post-romantique
  // (per arbitrage utilisateur — l'ensemble prime sur le répertoire)
  'orchestra of the age of enlightenment', 'oae',
  'les siècles', 'les siecles',
  // L'Arpeggiata (Christina Pluhar)
  "l'arpeggiata", 'arpeggiata', 'christina pluhar',
];

// Liste des compositeurs "non-baroque" qui invalidente le source-default
// AMUZ → baroque (per arbitrage utilisateur Q3 round 2). Couvre classique
// + romantique + post-romantique + contemporain ; ne couvre PAS les
// baroques/renaissance qui font le cœur du répertoire AMUZ.
const NON_BAROQUE_COMPOSERS = new Set([
  // Classique + romantique + post-romantique
  'Beethoven', 'Schubert', 'Brahms', 'Mendelssohn', 'Schumann', 'Chopin',
  'Liszt', 'Berlioz', 'Wagner', 'Verdi', 'Bruckner', 'Mahler', 'R. Strauss',
  'Tchaïkovski', 'Dvořák', 'Sibelius', 'Rachmaninov', 'Saint-Saëns', 'Fauré',
  'Bizet', 'Puccini', 'Massenet', 'Gounod', 'Bizet', 'Offenbach',
  // Modernes XXe
  'Stravinsky', 'Bartók', 'Prokofiev', 'Chostakovitch', 'Ravel', 'Debussy',
  'Britten', 'Poulenc', 'Janáček', 'Hindemith', 'Schoenberg', 'Berg', 'Webern',
  'Shostakovich', 'Copland', 'Gershwin', 'Piazzolla', 'Bernstein',
  'Holst', 'Vaughan Williams', 'Elgar', 'Grieg', 'Mussorgsky', 'Rimski-Korsakov',
  // Mozart/Haydn — classique pur, pas baroque non plus
  'Mozart', 'Haydn',
  // Tous les contemporains (référence ci-dessous)
]);
const BAROQUE_PROGRAM_HINTS = [
  /\binstruments d['']?[ée]poque\b/i, /\binstruments anciens\b/i,
  /\bhistorically informed\b/i, /\bdiapason historique\b/i,
];

// ---------------------------------------------------------------
// Règle 3 — contemporaine
// ---------------------------------------------------------------
// Q4 round 2 — qualifier OBLIGATOIRE pour éviter les false positives
// sur "création" tout court (mot fréquent dans descriptifs).
const CONTEMPORARY_TITLE_HINTS = [
  /\bcr[ée]ation\s+mondiale\b/i, /\bpremi[èe]re\s+mondiale\b/i,
  /\bworld\s+premiere\b/i, /\bfirst\s+performance\b/i,
  /\bnouvelle\s+œuvre\b/i, /\bœuvre\s+nouvelle\b/i,
];
const CONTEMPORARY_ENSEMBLES = [
  'ictus', 'asko|schönberg', 'asko schönberg', 'spectra', 'klangforum wien',
  'klangforum', 'ensemble modern', 'musiques nouvelles', 'hermes ensemble',
  'echo collective', "champ d'action", 'ensemble intercontemporain',
  'bl!ndman', 'blindman', 'nadar ensemble', 'hopper ensemble', 'eshu duo',
  'eshu',
];
const CONTEMPORARY_SOURCES = new Set(['senghor', 'wildewesten']);
const CONTEMPORARY_FESTIVAL_IDS = new Set([
  'ars-musica-2026', 'ekinox-2026', 'contrastes-2026',
]);
const CONTEMPORARY_COMPOSERS = new Set([
  // International post-1950
  'Ligeti', 'Kurtág', 'Boulez', 'Stockhausen', 'Berio', 'Sciarrino', 'Lachenmann',
  'Henze', 'Kaija Saariaho', 'Pärt', 'Adès', 'Salonen', 'Anderson', 'Adams',
  'Glass', 'Reich', 'Andriessen', 'Crumb', 'Cage', 'Xenakis', 'Feldman',
  'Riley', 'Rihm', 'Dutilleux', 'Shaw', 'Sofia Goubaïdulina',
  // Belgian contemporary
  'Mernier', 'Boesmans', 'Henderickx', 'Wim Henderickx', 'Capelletti',
  'Pousseur', 'Goeyvaerts', 'Karel Goeyvaerts', 'Frédéric Devreese',
  'Stefan Prins', 'Daan Janssens', 'Annelies Van Parys', 'Bram Van Camp',
  'Frederik Neyrinck', 'Wim Mertens',
  // Régionaux français contemporain
  'Connesson', 'Robin', 'Dusapin', 'Manoury', 'Hurel', 'Levinas',
]);

// ---------------------------------------------------------------
// Règle 4 — symphonique
// ---------------------------------------------------------------
// Ensembles symphoniques OU orchestres de chambre (per arbitrage B
// utilisateur : "Chamber Orchestra" inclus dans symphonique car
// répertoire orchestral classique).
const SYMPHONIC_ENSEMBLES = [
  'orchestre symphonique', 'symphony orchestra', 'symphonieorchester',
  'philharmonique', 'philharmonic', 'philharmoniker',
  'sinfonia varsovia', 'sinfonia iuventus',
  'brussels philharmonic', 'belgian national orchestra',
  'antwerp symphony orchestra', 'defilharmonie', 'de filharmonie',
  'orchestre philharmonique royal de liège', 'oprl',
  'orchestre de la monnaie', "orchestre symphonique de l'opéra",
  'orchestre royal de chambre de wallonie', 'orcw',
  'brussels sinfonietta', 'brussels chamber orchestra',
  'casco phil', 'casco philharmonic',
  'philzuid', 'philharmonie zuid', 'philharmonie zuid-nederland',
  // Orchestres de chambre — inclus dans symphonique (arbitrage B)
  'chamber orchestra', 'kammerorchester', 'orchestre de chambre',
  'philharmonia',
  // Q5 round 2 — wind orchestras / youth orchestras / brassband / harmonie
  'wind orchestra', 'youth orchestra', 'brassband', 'brass band',
  'orchestre d\'harmonie', 'orchestre harmonie',
  'chœur symphonique', 'choeur symphonique',
];
const SYMPHONIC_TITLE_HINTS = [
  /\bsymphonie\s*n[°o]?\s*\d/i, /\bsymphony\s*no\.?\s*\d/i,
  /\bconcerto pour (piano|violon|violoncelle|alto|hautbois|cor|trompette|fl[ûu]te|clarinette)\b/i,
  /\b(piano|violin|cello) concerto\b/i,
];

// Phase 3.38 mini-correction — concerts choraux comme ENTITÉ
// principale (grand effectif vocal) → symphonique. Distingue l'entité
// chorale du simple format (titre "Pièces pour chœur" reste chambre).
// Les ensembles baroques (Pygmalion, Vox Luminis, Collegium Vocale)
// priment toujours via règle 1. Ces patterns sont matchés sur le
// TITRE SEUL (pas le program) pour éviter les false positives sur
// les programs descriptifs qui mentionnent "chorus" ou "chœur"
// comme contexte (cas Budapest Festival Orchestra & Fischer, Songs
// of Travel, Passion selon St-Matthieu).
const CHORAL_TITLE_HINTS = [
  /^ch[œo]ur\b/i,                                   // titre commence par Chœur
  /\bch[œo]ur\s+(du|de|des|of|der|symphonique)\b/i, // Chœur du Pôle hainuyer
  /\bkoor\s*&|&\s*koor\b/i,                         // Koor & Orkest
  /\borchestra\s*&\s*choir\b|\bchoir\s*&\s*orchestra\b/i,
  /\b&\s*chorus\b|\bsymphony\s+chorus\b/i,          // "& Chorus" en fin de titre
  /\bk[ao]mmerchor\b/i,                              // Kammerchor (DE)
];
const SYMPHONIC_SOURCES = new Set(['oprl', 'antwerp-symphony', 'philzuid']);

// ---------------------------------------------------------------
// Règle 5 — chambre & récital
// ---------------------------------------------------------------
const CHAMBER_PERFORMER_PATTERNS = [
  /\bquatuor\b/i, /\bstring quartet\b/i, /\bquartet+\b/i, /\bquartett\b/i,
  /\bcuarteto\b/i, /\btrio\b/i, /\bquintette?\b/i, /\bquintet\b/i,
  /\bduo\b/i, /\bsextuor\b/i, /\bsextet\b/i, /\boctet\b/i, /\boctuor\b/i,
  // Q5 round 2 — variantes NL/allemandes
  /\bkwartet+(?:en)?\b/i, /\bstrijkkwartet+\b/i,           // NL : kwartet, kwartetten, strijkkwartet
  /\bkammerensemble\b/i, /\bbl[äa]serquintett\b/i,          // DE
  /\bstrijkers\b/i,                                         // NL (cordes)
];
// Pattern récital soliste : "Nom, instrument"
const SOLO_RECITAL_PATTERN =
  /,\s*(piano|violon|violoncelle|alto|contrebasse|orgue|guitare|harpe|fl[ûu]te|hautbois|clarinette|saxophone|trompette|cor|trombone|basson|clavecin|pianoforte|fortepiano|harpsichord|soprano|mezzo|t[ée]nor|baryton|basse|chant|voix)\b/i;
const CHAMBER_TITLE_PATTERNS = [
  /\br[ée]cital\b/i, /\blieder\b/i, /\bm[ée]lodies\b/i,
  /\bsonates? pour\b/i, /\bchants? de\b/i, /\bsongs? of\b/i,
  /\bconcert de midi\b/i,
];
const CHAMBER_SOURCES = new Set([
  'chapelle', 'midi-minimes', 'musicorum', 'voix-intimes', 'valdieu',
  'biereau', 'crb', 'mim', 'kbr', 'midiliege',
]);

// ---------------------------------------------------------------
// Q6 round 2 — fallback "récital-friendly" : venues où un concert
// classique sans signal d'ensemble est, par défaut, un récital soliste
// (Sokolov à DeSingel, Trifonov à Bozar, …).
// ---------------------------------------------------------------
const VENUES_RECITAL_FRIENDLY = new Set([
  // Listes explicites par ID
  'desingel', 'bozar', 'flagey',
  'conservatoire-royal-bruxelles', 'conservatoire-tournai',
  'bijloke', 'concertgebouwbrugge',
  'cite-miroir', 'chapelle-reine-elisabeth',
  'mim', 'kbr', 'mrbab-auditorium',
  'biereau', 'midi-minimes',
  'voix-intimes-tournai', 'musicorum',
  'abbaye-val-dieu', 'espace-senghor-etterbeek',
  // Round 3 — venues additionnelles
  'amuz', 'triangel', 'obf-festival',
  'grandmanege', 'oprl', 'lamonnaie',
  'stavelot-festival', 'silly-festival',
  '30cc-leuven', 'cchasselt', 'arts2',
  'miry-concertzaal-gent', 'de-vooruit-gent',
  'symfonisch-huis-antwerpen', 'reine-elisabeth-antwerpen',
  'stadsschouwburg-antwerpen', 'stadsschouwburg-brugge',
]);
// Matche aussi par nom contenant un mot-clé "salle à récital"
const VENUE_NAME_RECITAL_RE = /\bconservatoire\b|\bchapelle\b|\bauditorium\b/i;
function isRecitalFriendlyVenue(venue) {
  if (!venue) return false;
  if (VENUES_RECITAL_FRIENDLY.has(venue.id)) return true;
  return VENUE_NAME_RECITAL_RE.test(`${venue.name || ''} ${venue.fullName || ''}`);
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function anyMatch(patterns, text) {
  if (!text) return null;
  for (const p of patterns) if (p.test(text)) return p.source;
  return null;
}
function anySubstring(needles, hay) {
  if (!hay) return null;
  const h = hay.toLowerCase();
  for (const n of needles) if (h.includes(n.toLowerCase())) return n;
  return null;
}
function festivalsOf(c) {
  if (Array.isArray(c.festivals)) return c.festivals;
  if (c.festival) return [c.festival];
  return [];
}

// ---------------------------------------------------------------
// Enrichissement (Option C round 3) — détecte les compositeurs cités
// dans le titre/programme même quand `composers[]` est vide (cas des
// scrapers DeSingel/Bijloke/Flagey qui n'extraient pas systématiquement).
// ---------------------------------------------------------------
function enrichComposers(concert, ctx) {
  const explicit = concert.composers || [];
  const out = new Set(explicit);
  const blob = `${concert.title || ''} | ${concert.program || ''}`;

  // 1) Détection via composers-reference.json (matchComposersFromText)
  if (ctx.composerIndex && blob.trim()) {
    for (const c of matchComposersFromText(blob, ctx.composerIndex)) {
      out.add(c);
    }
  }
  // 2) Alias phonétiques NL/DE/EN
  for (const [phonetic, canon] of Object.entries(PHONETIC_ALIASES)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${phonetic}(?![\\p{L}\\p{N}_])`, 'iu');
    if (re.test(blob)) out.add(canon);
  }
  // 3) Œuvres iconiques (skip si déjà ≥1 composer explicite et non-Bach/Haendel)
  for (const { pattern, composer } of ICONIC_WORKS) {
    if (pattern.test(blob)) {
      // Évite d'injecter Bach sur un Magnificat de Vivaldi si Vivaldi déjà présent
      const otherComposerExplicit = explicit.some(
        (c) => c !== composer && !BAROQUE_OR_EARLY_COMPOSERS.has(c) === false
      );
      if (!otherComposerExplicit) out.add(composer);
    }
  }
  return [...out];
}

function hasNonClassicalArtist(blob) {
  const b = blob.toLowerCase();
  for (const a of KNOWN_NON_CLASSICAL_ARTISTS) {
    if (b.includes(a)) return a;
  }
  return null;
}

// ---------------------------------------------------------------
// Classify
// ---------------------------------------------------------------
// `ctx` peut contenir :
//   - venuesById : Map venue.id → venue
//   - composerIndex : index loadé via composer-filter.loadComposerIndex
export function classify(concert, ctx = {}) {
  const signals = [];
  const title = concert.title || '';
  const program = concert.program || '';
  const performers = (concert.performers || []).join(' | ');
  const composers = enrichComposers(concert, ctx);
  const blob = [title, program, performers].filter(Boolean).join(' | ');
  const source = concert.source;
  const fests = festivalsOf(concert);
  const venue = ctx.venuesById ? ctx.venuesById.get(concert.venue_id) : null;

  // Règle 0 — hors-catégorie hard
  const hors = anyMatch(HORS_CATEGORIE_PATTERNS, blob);
  if (hors) {
    signals.push(`hors-pattern=${hors}`);
    return { category: 'hors-categorie', signals };
  }

  // Règle 0.5 — ballet hors maison lyrique → hors-catégorie
  // Phase 3.38 — un ballet (titre contient "ballet" / "dansé(es)" /
  // "chorégraphie") qui n'est PAS produit par une maison lyrique
  // (ORW / OPL / OBV / Monnaie) tombe en hors-catégorie. Les ballets
  // de ces 4 maisons restent classés opera per arbitrage utilisateur.
  if (BALLET_HORS_LYRIQUE.test(title) && !OPERA_SOURCES.has(source)) {
    signals.push('ballet-non-lyrical');
    return { category: 'hors-categorie', signals };
  }

  // Règle 1 — baroque & ancienne (ENSEMBLE / FESTIVAL prime sur tout
  // sauf hors-cat hard & ballet)
  // Phase 3.38 — réordonné AVANT l'opéra per arbitrage utilisateur
  // Round 2 (Q8 "Vox Luminis joue Brahms → baroque, ensemble prime
  // sur répertoire"). Conséquence : un ensemble baroque jouant un
  // opéra-baroque (a nocte temporis, Concert d'Astrée, Cappella
  // Amsterdam…) est classifié baroque-ancienne plutôt qu'opera,
  // même si le titre/programme mentionne Médée / Alcina / Orlando /
  // Boréades / Dardanus / etc.
  if (BAROQUE_SOURCES.has(source)) {
    const hasModern = composers.some((c) =>
      NON_BAROQUE_COMPOSERS.has(c) || CONTEMPORARY_COMPOSERS.has(c)
    );
    if (source !== 'amuz' || !hasModern) {
      signals.push(`baroque-source=${source}`);
      return { category: 'baroque-ancienne', signals };
    }
    signals.push(`baroque-source-skipped(amuz+modern-composer)`);
  }
  for (const f of fests) {
    if (BAROQUE_FESTIVAL_IDS.has(f)) {
      signals.push(`baroque-festival=${f}`);
      return { category: 'baroque-ancienne', signals };
    }
  }
  const baroqueEns = anySubstring(BAROQUE_ENSEMBLES, blob);
  if (baroqueEns) {
    signals.push(`baroque-ensemble=${baroqueEns}`);
    return { category: 'baroque-ancienne', signals };
  }
  const baroqueProg = anyMatch(BAROQUE_PROGRAM_HINTS, blob);
  if (baroqueProg) {
    signals.push(`baroque-program=${baroqueProg}`);
    return { category: 'baroque-ancienne', signals };
  }

  // Règle 2 — opéra (Phase 3.38 — réordonné APRÈS la baroque-ensemble
  // pour respecter l'arbitrage "ensemble baroque prime sur répertoire").
  // OPERA_HARD_NEGATIVE s'applique aux DEUX paths (title-match +
  // source-default). Évite que "Concert d'ouverture", "Concertini",
  // "Musica da camera" tombent en opera.
  const operaNegative = OPERA_HARD_NEGATIVE.test(title);
  if (!operaNegative) {
    const operaTitle = anyMatch(OPERA_TITLE_PATTERNS, blob);
    if (operaTitle) {
      signals.push(`opera-title=${operaTitle}`);
      return { category: 'opera', signals };
    }
    if (OPERA_SOURCES.has(source)) {
      signals.push(`opera-source=${source}`);
      return { category: 'opera', signals };
    }
  }
  // Si OPERA_HARD_NEGATIVE matche le titre, on saute la règle opéra
  // entière (laisse passer aux règles suivantes : contemporaine,
  // symphonique, chambre/récital, era-based fallback).

  // Règle 3 — contemporaine
  const contTitle = anyMatch(CONTEMPORARY_TITLE_HINTS, blob);
  if (contTitle) {
    signals.push(`contemp-title=${contTitle}`);
    return { category: 'contemporaine', signals };
  }
  const contEns = anySubstring(CONTEMPORARY_ENSEMBLES, blob);
  if (contEns) {
    signals.push(`contemp-ensemble=${contEns}`);
    return { category: 'contemporaine', signals };
  }
  if (CONTEMPORARY_SOURCES.has(source)) {
    signals.push(`contemp-source=${source}`);
    return { category: 'contemporaine', signals };
  }
  for (const f of fests) {
    if (CONTEMPORARY_FESTIVAL_IDS.has(f)) {
      signals.push(`contemp-festival=${f}`);
      return { category: 'contemporaine', signals };
    }
  }
  if (composers.length > 0) {
    const n = composers.filter((c) => CONTEMPORARY_COMPOSERS.has(c)).length;
    if (n / composers.length >= 0.5) {
      signals.push(`contemp-composers=${n}/${composers.length}`);
      return { category: 'contemporaine', signals };
    }
  }

  // Règle 4 — symphonique
  const symEns = anySubstring(SYMPHONIC_ENSEMBLES, blob);
  if (symEns) {
    signals.push(`sym-ensemble=${symEns}`);
    return { category: 'symphonique', signals };
  }
  const symTitle = anyMatch(SYMPHONIC_TITLE_HINTS, blob);
  if (symTitle) {
    signals.push(`sym-title=${symTitle}`);
    return { category: 'symphonique', signals };
  }
  // Phase 3.38 mini — entité chorale dans le titre seul → symphonique.
  const choralTitle = anyMatch(CHORAL_TITLE_HINTS, title);
  if (choralTitle) {
    signals.push(`sym-choral=${choralTitle}`);
    return { category: 'symphonique', signals };
  }
  if (SYMPHONIC_SOURCES.has(source)) {
    signals.push(`sym-source=${source}`);
    return { category: 'symphonique', signals };
  }

  // Règle 5 — chambre/récital
  const chamberPerf = anyMatch(CHAMBER_PERFORMER_PATTERNS, performers || blob);
  if (chamberPerf) {
    signals.push(`chamber-performer=${chamberPerf}`);
    return { category: 'chambre-recital', signals };
  }
  const soloRec = SOLO_RECITAL_PATTERN.exec(performers + ' ' + title);
  if (soloRec) {
    signals.push(`chamber-solo-pattern=${soloRec[1]}`);
    return { category: 'chambre-recital', signals };
  }
  const chamberTitle = anyMatch(CHAMBER_TITLE_PATTERNS, title);
  if (chamberTitle) {
    signals.push(`chamber-title=${chamberTitle}`);
    return { category: 'chambre-recital', signals };
  }
  if (CHAMBER_SOURCES.has(source)) {
    signals.push(`chamber-source=${source}`);
    return { category: 'chambre-recital', signals };
  }

  // Round 3 — fallback à 3 étages :
  //
  // (a) Era-based : si composers (enrichis title/program/phonétique/
  //     œuvres iconiques) dominent une époque, on classe en
  //     conséquence (per directive utilisateur Q1/Q3).
  //       ≥50% pre-1750  → baroque-ancienne
  //       ≥50% post-1950 → contemporaine
  //
  // (b) Récital-friendly venue + pas d'artiste jazz/world connu :
  //     présomption récital classique (Option D round 3).
  //
  // (c) Sinon → hors-catégorie (vrai fallback).
  if (composers.length > 0) {
    const baroque = composers.filter((c) => BAROQUE_OR_EARLY_COMPOSERS.has(c)).length;
    const contemp = composers.filter((c) => CONTEMPORARY_COMPOSERS.has(c)).length;
    if (baroque / composers.length >= 0.5) {
      signals.push(`era-baroque-composers=${baroque}/${composers.length}`);
      return { category: 'baroque-ancienne', signals };
    }
    if (contemp / composers.length >= 0.5) {
      signals.push(`era-contemp-composers=${contemp}/${composers.length}`);
      return { category: 'contemporaine', signals };
    }
  }
  if (isRecitalFriendlyVenue(venue)) {
    const nonClassical = hasNonClassicalArtist(blob);
    if (!nonClassical) {
      signals.push(`chamber-fallback(venue=${venue.id},composers=${composers.length})`);
      return { category: 'chambre-recital', signals };
    }
    signals.push(`chamber-fallback-blocked(non-classical=${nonClassical})`);
  }

  // Fallback final — vrai hors-catégorie
  signals.push('fallback');
  return { category: 'hors-categorie', signals };
}
