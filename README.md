# jobmailboard

Dashboard de suivi de la veille emploi. Local, sans build, sans base de données.

```
jobmailboard/
├── AGENTS.md                 contrat de la tâche planifiée
├── install/                  installation et prompt de la tâche planifiée
├── orchestrator/             cycle complet : collecte, ingestion, notification
├── config/                   critères de tri, préférences, canaux, JEV — voir config/README.md
├── collectors/browser-mail/  collecte par navigateur (Proton, Edge) — voir son README
├── profile/                  CV et digest anonymisé (ignoré par Git)
├── JEV_INTEGRATION.md        enrichissement JEV optionnel (conception)
├── COLLECTE_MULTICANAL.md    collecte multi-source Gmail/Proton (conception)
├── ingest/
│   ├── ingest.mjs            déduplication + génération du dashboard
│   └── schema.md             contrat du fichier de run
├── data/
│   ├── runs-inbox/           dépose des runs ici (consommé puis vidé)
│   ├── runs-archive/         runs déjà ingérés
│   ├── messages.jsonl        index : un mail par ligne, sans le corps
│   ├── bodies.jsonl          corps des mails, un par ligne
│   └── runs.jsonl            un run par ligne
├── settings/                 éditeur local des fichiers de configuration
└── dashboard/
    ├── index.html            ouvrir au double-clic
    ├── app.js
    ├── style.css
    ├── data.js               généré — index
    └── bodies.js             généré — corps, chargé à la demande
```

## Stockage

Pas de base de données : trois fichiers JSONL sur disque font office de stockage.
Append-only, lisibles à l'œil, greppables, versionnables.

L'index (`messages.jsonl`) et les corps (`bodies.jsonl`) sont séparés pour une raison
précise : le dashboard charge l'index au démarrage, et ne tire `bodies.js` qu'au premier
déploiement de mail ou à la première recherche. Un historique d'un an reste ainsi
instantané à ouvrir.

Les corps arrivent par balise `<script>` injectée, pas par `fetch` — c'est ce qui permet
d'ouvrir `index.html` en `file://` sans serveur, `fetch` étant bloqué sur ce protocole.

## Installation

Voir [install/README.md](install/README.md) : canaux, profil Edge, tâche
planifiée.

## Utilisation

La tâche planifiée dépose le run Gmail puis lance le cycle :

```bash
node orchestrator/run-cycle.mjs
```

La dernière ligne contient `mailboard.cycle.result` ; son champ `notify` décide
de la notification. Voir [orchestrator/README.md](orchestrator/README.md).

Pour ingérer à la main ce qui attend dans `data/runs-inbox/` :

```bash
node ingest/ingest.mjs --json
```

Puis ouvrir `dashboard/index.html`. Pour ne régénérer que le dashboard :

```bash
node ingest/ingest.mjs --rebuild
```

### Modifier les réglages dans l’interface

Le dashboard ouvert au double-clic reste en lecture seule. Pour éditer les critères,
les préférences et les objets JEV, lancer le processus local temporaire :

```bash
node settings/server.mjs
```

Puis ouvrir l’adresse affichée (`http://127.0.0.1:4177/` par défaut) et cliquer sur
**Réglages**. L’éditeur :

- valide les trois objets avant toute écriture ;
- n’expose ni clé API, ni CV, ni `channels.local.json` ;
- écrit `criteria.json`, `preferences.json` et `jev.json`, puis lance un rebuild ;
- restaure les versions précédentes si le rebuild échoue.

Le service écoute uniquement sur `127.0.0.1`, protège son API avec un jeton créé au
démarrage et s’arrête avec `Ctrl+C`.

Pour voir ce qui serait ingéré sans rien écrire :

```bash
node ingest/ingest.mjs --dry
```

Pour évaluer les nouveaux messages avec JEV (shadow mode — les décisions sont
stockées, rien ne les affiche encore) :

```bash
node ingest/ingest.mjs --jev
```

Il faut `TYPESAFE_API_KEY` dans l'environnement. Sans clé, l'ingestion se
déroule à l'identique et chaque message porte `jev.status: "skipped"`. `--dry`
coupe les appels même avec `--jev` : une simulation ne coûte rien.

Pour évaluer l'historique déjà ingéré, par lots (du plus récent au plus ancien) :

```bash
node ingest/jev-backfill.mjs --dry --source gmail-primary --limit 20
node ingest/jev-backfill.mjs --source gmail-primary --limit 20
```

Lancer la commande vaut opt-in, même si `config/jev.json` porte
`enabled: false`. Sont repris les messages sans bloc `jev`, ou en `skipped` /
`error` ; `--stale` ajoute les décisions dont le jeu de questions ou l'entrée a
changé. `--limit` est plafonné à 200. Une erreur ne remplace jamais une décision
`ok` déjà acquise, et le dashboard est régénéré à la fin.

```bash
node --test
```

## Ce que montre le dashboard

- **KPI** : volume sur 7 jours, répartition par catégorie, reste à traiter.
- **Couverture des runs** : une barre par run. Grise = le run a tourné sans rien
  trouver de neuf. Un trou dans la série signale une veille qui n'a pas tourné.
- **Messages** : filtrables par source, par catégorie et par recherche plein texte — objet,
  expéditeur, résumé **et corps du mail**. Les occurrences trouvées dans le corps
  apparaissent sous forme d'extrait surligné.
- **Détail** : cliquer l'objet déplie le corps complet du mail dans la page.

## Limites connues

- Un mail sans `body` dans le run reste listé et cherchable sur objet/expéditeur/résumé,
  mais affiche « corps non capturé ». Un run ultérieur peut combler le trou.
- Les corps sont tronqués à 12 000 caractères à l'ingestion (constante `BODY_MAX`).
- L'état « traité » est stocké par navigateur (localStorage). Changer de navigateur ou
  vider les données du site le réinitialise.
- En ouverture directe (`file://`), aucune écriture n’est possible. L’édition demande
  le processus local `settings/server.mjs`, lancé volontairement et arrêté après usage.
