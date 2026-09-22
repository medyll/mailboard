# Architecture et validité de Mailboard

État observé le 22 septembre 2026 dans le workspace local.

## Verdict

Mailboard est une **alpha locale fonctionnelle**. Ce n'est plus une maquette :
le projet collecte déjà deux sources, normalise les messages, déduplique les
runs, conserve les données en JSONL et produit un dashboard utilisable sans
serveur.

Jauge globale : **7/10**.

Cette note ne signifie pas « 70 % des fichiers écrits ». Elle mesure la distance
jusqu'à un outil personnel qui tourne seul, détecte ses trous de couverture et
peut être repris sans inspection manuelle après une panne.

| Zone | Niveau | Constat |
|---|---:|---|
| stockage et ingestion | 9/10 | données cohérentes, déduplication multi-source, compatibilité historique |
| dashboard local | 8/10 | projection statique complète, filtres, recherche, corps chargés à part, état local |
| collecte Gmail | 7/10 | données réelles présentes, mais collecte pilotée par la tâche externe |
| collecte Proton/Edge | 7/10 | un run réel complet existe ; l'attachement Edge dépend encore d'une préparation locale |
| JEV métier | 5/10 | adaptateur bien testé, aucune décision réelle persistée dans les données actuelles |
| exploitation continue | 4/10 | pas d'orchestrateur unique, pas de CI, endpoint Edge indisponible lors du contrôle |

Le bon nom de phase est donc : **socle validé, automatisation encore incomplète**.

## Preuves relevées

Le contrôle local donne les résultats suivants :

- 34 tests automatisés passent, aucun n'échoue ;
- 11 fichiers JavaScript passent `node --check` ;
- `node ingest/ingest.mjs --dry` termine sans écriture ni appel JEV ;
- 306 messages et 9 runs sont lisibles ;
- aucun message n'a d'identifiant manquant ou dupliqué ;
- `dashboard/data.js` contient les mêmes 306 messages et 9 runs ;
- le run Proton archivé a inspecté 150 lignes, en a retenu 141 et déclare une
  couverture complète ;
- Gmail fournit 161 messages sous `gmail-primary`, auxquels s'ajoutent 4 anciens
  messages sous `gmail-legacy` ;
- les deux runs Gmail `partial` correspondent aux pages 1 et 2 d'une reprise
  historique, suivies d'une page 3 marquée complète. Rien n'indique ici une
  perte silencieuse.

Le test d'attachement Edge a renvoyé `needs_user` parce qu'aucun endpoint CDP
n'écoutait sur `127.0.0.1:9222` au moment du contrôle. Le code a donc réagi comme
prévu, mais le canal Proton ne pouvait pas être relancé sur-le-champ.

## Architecture actuelle

```text
                         PLAN DE CONTRÔLE

  config/criteria.json      ce qui doit être collecté et classé
  config/channels*.json     sources, fournisseurs et modes d'accès
  config/preferences.json   souhaits et refus, évalués localement
  config/jev.json           questions, modèle, seuils, concurrence
  profile/profile.jev.md    digest du profil, facultatif pour JEV
               │
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         COLLECTE                                     │
│                                                                      │
│  tâche Gmail / connecteur                Microsoft Edge authentifié  │
│       │                                         │ CDP                │
│       │                                         ▼                    │
│       │                              collectors/browser-mail/        │
│       │                                ├─ edge.mjs                   │
│       │                                ├─ collect.mjs                │
│       │                                ├─ providers/proton.mjs       │
│       │                                └─ jev_driver.py, optionnel   │
│       │                                         │                    │
│       └──────────────────┬──────────────────────┘                    │
│                          │ runs JSON v1 ou v2                        │
└──────────────────────────┼───────────────────────────────────────────┘
                           ▼
                 data/runs-inbox/
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         INGESTION                                    │
│                                                                      │
│  validation et normalisation                                        │
│       │                                                              │
│  messageKey = sourceId + ":" + id                                   │
│       │                                                              │
│  déduplication                                                       │
│       │                                                              │
│  enrichissement JEV métier, facultatif et non bloquant               │
│       │                                                              │
│  archivage du run + écritures JSONL                                  │
└───────┬───────────────────┬───────────────────┬──────────────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
 data/messages.jsonl  data/bodies.jsonl   data/runs.jsonl
        │                   │                   │
        └───────────────────┴───────────────────┘
                            │ rebuild
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         PROJECTION                                   │
│                                                                      │
│  dashboard/data.js               index, sources, métriques, prefs    │
│  dashboard/bodies.js             corps séparés                       │
└───────────────────────────┬──────────────────────────────────────────┘
                            ▼
                  dashboard/index.html
                            │
                            ▼
          recherche, filtres, fraîcheur par source,
          préférences, détail des messages, couverture
                            │
                            ▼
              localStorage : traité, thème, masquages
```

## Lecture par couche

### 1. Configuration

[`config/load.mjs`](config/load.mjs) centralise la lecture des fichiers, les
surcharges par variables d'environnement, la résolution des secrets et la
compatibilité des anciennes catégories.

Les fichiers ont des rôles distincts :

- `criteria.json` dit quels types de messages rechercher et comment les classer ;
- `channels.local.json` décrit les comptes et leur mode d'accès ;
- `preferences.json` encode les éléments souhaités ou à éviter ;
- `jev.json` versionne les questions envoyées au modèle ;
- le digest de profil n'est envoyé qu'aux questions qui en ont besoin.

Ce découpage est juste. Les préférences restent déterministes et locales ; JEV
n'intervient que là où une décision sémantique apporte quelque chose.

### 2. Collecte

Deux familles de canaux produisent aujourd'hui des runs.

#### Gmail

La tâche planifiée cherche les messages selon les requêtes de critères, puis
écrit un fichier dans `data/runs-inbox/`. Gmail reste donc un collecteur externe
au runtime Node de Mailboard.

Cette frontière convient à un outil personnel, mais elle a une conséquence : le
dépôt seul ne suffit pas à reproduire la collecte Gmail. Il faut aussi la tâche,
ses autorisations et son environnement.

#### Proton dans Edge

[`collectors/browser-mail/collect.mjs`](collectors/browser-mail/collect.mjs)
produit un run et ne lance jamais l'ingestion. C'est une bonne séparation.

[`collectors/browser-mail/edge.mjs`](collectors/browser-mail/edge.mjs) s'attache
par CDP à Edge, vérifie le produit et le profil quand Edge les expose, crée un
onglet en arrière-plan, puis ferme uniquement cet onglet.

[`collectors/browser-mail/providers/proton.mjs`](collectors/browser-mail/providers/proton.mjs)
contient toute la connaissance du DOM Proton : connexion, compte attendu,
sélecteurs de lignes, pagination, dates localisées et identité des messages. Un
changement du webmail ne contamine donc ni l'ingesteur ni le dashboard.

La navigation possède deux moteurs :

- `direct`, utilisé par défaut, suit un chemin connu sans coût ni envoi du texte
  visible à un modèle ;
- `jev`, via `jev_driver.py`, confie à `jev-ultrafast` le choix des actions quand
  le chemin devient variable.

Le run réel Proton archivé a utilisé `cdp-déterministe`, pas `jev-ultrafast`.
Le README du collecteur mentionne un essai JEV réussi en 3 actions avec 50 lignes
lues, mais cette preuve n'apparaît pas comme run archivé distinct.

### 3. Ingestion canonique

[`ingest/ingest.mjs`](ingest/ingest.mjs) constitue le centre du système. Il :

1. lit tous les runs disponibles ;
2. accepte l'ancien contrat Gmail et le contrat multicanal v2 ;
3. calcule une identité composée du canal et de l'identifiant externe ;
4. met à jour les occurrences déjà vues sans créer de doublon ;
5. enrichit les nouveaux messages si JEV est activé ;
6. écrit l'index, les corps et les métriques de run ;
7. déplace les fichiers traités vers `data/runs-archive/` ;
8. régénère les deux fichiers consommés par le dashboard.

Le mode `--dry` coupe les écritures et les appels JEV. Cette propriété est déjà
testée par l'exécution réelle.

### 4. Les deux usages de JEV

Le système garde deux usages séparés, et il faut conserver cette séparation.

```text
JEV navigation
  état de page + contrôles → prochaine action navigateur
  propriétaire : collectors/browser-mail/jev_driver.py

JEV métier
  message normalisé + questions → décisions probabilistes
  propriétaire : ingest/jev.mjs
```

[`ingest/jev.mjs`](ingest/jev.mjs) réduit l'état envoyé : domaine expéditeur,
objet, résumé, catégorie et préférences utiles. Il valide les réponses, borne la
concurrence, classe les erreurs HTTP et ne réessaie pas aveuglément.

L'implémentation est crédible côté tests, mais pas encore prouvée sur les données
réelles : 302 messages portent `jev.status: skipped`, 4 anciens messages n'ont
aucun bloc JEV et aucun run de métrique JEV n'existe. Le shadow mode n'a donc pas
commencé en pratique.

### 5. Stockage

Les fichiers JSONL servent de base locale :

| Fichier | Rôle |
|---|---|
| `data/messages.jsonl` | index canonique des messages |
| `data/bodies.jsonl` | corps ou extraits longs, séparés de l'index |
| `data/runs.jsonl` | couverture, provenance et résultat des collectes |
| `data/jev-runs.jsonl` | métriques des appels JEV, créé au premier appel réel |
| `data/runs-archive/` | entrées brutes déjà consommées |

Le choix JSONL reste adapté au volume actuel. Il rend les runs auditables sans
introduire une base ou un serveur trop tôt.

Seulement deux corps sont stockés à ce jour. L'architecture sait les gérer, mais
la collecte du contenu détaillé n'a pas encore une couverture représentative.

### 6. Dashboard

[`dashboard/app.js`](dashboard/app.js) lit les projections générées. Il montre :

- la fraîcheur par source et l'état du dernier run ;
- les volumes, catégories et trous de couverture ;
- les préférences positives ou bloquantes ;
- la recherche dans l'index, puis dans les corps chargés à la demande ;
- le détail d'un message et son lien vers le fournisseur ;
- l'état « traité », conservé dans `localStorage`.

Le dashboard n'écrit jamais dans les JSONL. C'est cohérent avec son ouverture en
`file://`, mais l'état traité reste lié au navigateur et au profil local.

## Ce qui est réellement validé

### Validé par données réelles

- import Gmail multi-page ;
- import Proton par Edge et CDP déterministe ;
- couverture Proton complète sur un run archivé ;
- normalisation multi-source et déduplication ;
- reconstruction du dashboard sur 306 messages.

### Validé hors ligne

- erreurs du collecteur et statuts de repli ;
- identité de secours et isolation par canal ;
- session Proton expirée, mauvais compte et DOM non reconnu ;
- parsing des dates Proton ;
- requêtes JEV, validation des réponses, timeout, erreurs HTTP et concurrence ;
- absence de secrets dans le run produit par le collecteur.

### Pas encore validé de bout en bout

- un cycle planifié qui lance Gmail, Proton, l'ingestion et la notification sans
  intervention ;
- l'attachement Edge à froid après redémarrage de la machine ;
- un run JEV métier réel avec coûts et probabilités persistés ;
- une collecte Proton réelle pilotée par `jev-ultrafast` et archivée comme telle ;
- le rendu du dashboard sous test navigateur ;
- la reprise après interruption entre l'archivage d'un run et les écritures JSONL.

## Limites qui baissent la note

### Edge n'est pas prêt au moment du run

Le contrôle `collect.mjs --check` a correctement retourné `needs_user`, mais le
port CDP n'était pas actif. Une tâche planifiée peut donc manquer Proton tant que
le démarrage Edge et l'autorisation de débogage ne sont pas stabilisés.

### Pas d'orchestrateur explicite

La collecte Gmail, la collecte Proton et l'ingestion existent, mais aucun
composant ne décrit un cycle complet avec états, ordre et reprise. Le
planificateur externe doit porter cette responsabilité. Les collecteurs ne
doivent pas appeler l'ingesteur eux-mêmes.

### Tests concentrés sur deux zones

Les 34 tests couvrent bien Proton et l'adaptateur JEV. Il manque un test fixture
qui dépose plusieurs runs, lance l'ingestion dans un répertoire temporaire et
compare les JSONL ainsi que les projections produites. Le dashboard n'a pas de
test DOM.

### JEV reste dormant

Le code existe, mais aucune décision métier réelle n'est conservée. Il serait
prématuré d'utiliser ses scores pour trier les notifications.

### Pas de dépôt Git initialisé

Le dossier courant n'est pas un dépôt Git. Pour une expérimentation locale, ce
n'est pas bloquant ; pour modifier les collecteurs ou le schéma sans perdre un
état fonctionnel, l'absence d'historique et de retour arrière devient vite
coûteuse.

## Prochain ordre de travail

### 1. Stabiliser le cycle Edge

Rendre le port CDP disponible après ouverture du profil attendu, puis exécuter
`collect.mjs --check` dans les mêmes conditions que la tâche planifiée. Le but
est d'obtenir une preuve répétable, pas seulement un essai interactif.

### 2. Ajouter un test d'ingestion bout en bout

Utiliser des runs fixtures v1 et v2, dont un doublon entre deux canaux. Le test
doit contrôler `messages.jsonl`, `runs.jsonl`, `bodies.jsonl`, l'archive et les
deux projections du dashboard.

### 3. Lancer le shadow mode JEV métier

Activer JEV sur un petit lot réel sans changer l'ordre d'affichage ni les
notifications. Conserver probabilités, latence, tokens, modèle et statut, puis
comparer les décisions à un jugement humain.

### 4. Formaliser l'orchestration

Le planificateur doit lancer chaque canal séparément, attendre les runs, lancer
l'ingestion une fois et notifier seulement à partir du résultat canonique. Un
canal en échec ne doit pas annuler les autres.

### 5. Tester le dashboard

Un test navigateur court suffit au départ : ouverture en `file://`, nombre
de messages, filtre de source, recherche, expansion d'un corps et persistance de
l'état traité.

### 6. Initialiser l'historique du projet

Créer un dépôt Git, ignorer `.venv`, `channels.local.json`, les données privées et
les profils, puis enregistrer cet état fonctionnel avant de toucher aux contrats.

## Décision d'architecture à conserver

Mailboard doit rester un pipeline de fichiers avec des adaptateurs remplaçables.
Le collecteur observe ; l'ingesteur décide ce qui entre dans les données
canoniques ; le dashboard ne modifie jamais la source.

```text
collecter → normaliser → dédupliquer → enrichir → projeter → consulter
```

Cette chaîne est assez simple pour rester inspectable et assez ouverte pour
ajouter Outlook, RSS ou un autre webmail sans réécrire le cœur.
