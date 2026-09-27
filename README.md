# @medyll/jobmailboard

Suivi local des mails emploi : stockage JSONL, dashboard statique, CLI et serveur MCP.
Le package est préparé pour npm, mais **n’est pas encore publié**. Les commandes
`npx` ci-dessous seront disponibles après sa première publication.

## Exécution immédiate

```sh
npx @medyll/jobmailboard
npx @medyll/jobmailboard --help
npx @medyll/jobmailboard --version
```

Sans commande, la CLI affiche l’aide. Node 22.22.2 ou plus récent est requis ;
la CI teste les lignes LTS 22 et 24 sur Windows, Linux et macOS.

## CLI

```sh
npx @medyll/jobmailboard init
npx @medyll/jobmailboard queries --provider gmail --window 12
npx @medyll/jobmailboard ingest --json
npx @medyll/jobmailboard cycle --skip-collect --json
npx @medyll/jobmailboard cycle --retry-failed --json
npx @medyll/jobmailboard collect --check
npx @medyll/jobmailboard collect --source proton-perso --observe
npx @medyll/jobmailboard missing-bodies --source gmail-primary --limit 20
npx @medyll/jobmailboard messages --query entretien
npx @medyll/jobmailboard message --source gmail-primary --id ID_EXTERNE
npx @medyll/jobmailboard rebuild
npx @medyll/jobmailboard jev-backfill --limit 20 --dry
npx @medyll/jobmailboard jev-agreement
npx @medyll/jobmailboard serve --port 4177
```

`serve` expose le dashboard et les réglages sur `127.0.0.1`. Le dashboard reste
ouvrable directement depuis `dashboard/index.html` dans l’espace utilisateur.
`--root <répertoire>` choisit cet espace ; `MAILBOARD_ROOT` fournit le même réglage.
Les résultats CLI vont sur stdout, les logs métier sur stderr ; `--json` produit
une seule ligne JSON pour le résultat.

Emplacements par défaut :

| Système | Espace persistant |
| --- | --- |
| Windows | `%LOCALAPPDATA%/jobmailboard` |
| Linux | `$XDG_DATA_HOME/jobmailboard` ou `~/.local/share/jobmailboard` |
| macOS | `~/Library/Application Support/jobmailboard` |

Cet espace contient `config/`, `data/`, `dashboard/` et `profile/`. Le package ne
s’en sert jamais comme répertoire d’installation npm. L’initialisation conserve
les fichiers présents ; les critères fournis au départ sont génériques, sans
compte ni préférence personnelle. JEV et l’envoi du profil sont désactivés.

Pour reprendre l’historique du dépôt, copier ses dossiers `config/`, `data/` et
`profile/` dans un espace extérieur au package, puis lancer `rebuild --root` sur
cet espace. Les fichiers générés du dashboard sont reconstruits depuis les JSONL.
Le contrat des runs reste décrit dans [ingest/schema.md](ingest/schema.md).
La CLI ne récupère pas les mails Gmail toute seule : l’agent ou un connecteur
dépose les runs, corps inclus, avant le cycle.

La collecte navigateur utilise le collecteur Node et un navigateur compatible
CDP déjà lancé sur le port configuré. Sous Windows, `MAILBOARD_PWSH=pwsh` active
le wrapper historique qui prépare Edge. PowerShell est facultatif. La navigation
JEV du collecteur reste une option nécessitant `uv`, Python et une clé Typesafe ;
voir [la documentation du collecteur](collectors/browser-mail/README.md).

## MCP

```sh
npx @medyll/jobmailboard mcp
```

Le transport est `stdio` : stdout contient exclusivement le protocole MCP.
Les logs vont sur stderr. Exemple de configuration d’un client :

```json
{
  "mcpServers": {
    "jobmailboard": {
      "command": "npx",
      "args": ["-y", "@medyll/jobmailboard", "mcp"],
      "env": { "MAILBOARD_ROOT": "/chemin/vers/espace-utilisateur" }
    }
  }
}
```

Adapter le chemin à son système. Sur Windows, certains clients utilisant `spawn`
sans shell ne peuvent pas lancer directement un `.cmd`. Utiliser leur option de
shell ou `command: "cmd"` avec
`args: ["/d", "/s", "/c", "npx -y @medyll/jobmailboard mcp"]`.
Une installation locale permet aussi de lancer `node` avec le chemin du fichier
`bin/jobmailboard.js`. Renommer simplement la commande en `npx.cmd` ne suffit pas
pour tous les clients.

Tools exposés : `list_messages`, `get_message`, `missing_bodies`,
`collection_queries`, `ingest_runs`, `rebuild_dashboard`, `run_cycle` et
`jev_backfill`. La ressource `jobmailboard://settings` expose les réglages bruts,
sans résoudre les valeurs `env:...`. `jev_backfill` constitue un opt-in à des
appels potentiellement facturables ; `dry: true` les évite.

Le serveur utilise le [SDK TypeScript MCP officiel v2](https://ts.sdk.modelcontextprotocol.io/v2/),
avec `@modelcontextprotocol/server` 2.1.0 et validation Zod. Les handlers MCP et
CLI appellent `Mailboard` directement, sans passer l’un par l’autre.

## API JavaScript / TypeScript

```ts
import { Mailboard } from '@medyll/jobmailboard';

const board = new Mailboard({ root: '/chemin/vers/espace-utilisateur' });
await board.ingest();
const messages = board.listMessages({ query: 'entretien', limit: 20 });
```

Les exports publics se limitent à `Mailboard`, `userWorkspace` et aux types
d’options/messages. Le JavaScript et les déclarations sont inclus dans le package ;
TypeScript n’est pas nécessaire chez l’utilisateur. Les mutations d’une même
instance sont mises en file. Éviter de lancer deux processus d’écriture sur le
même espace simultanément.

## Développement et validation

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack
npm run smoke
node bin/jobmailboard.js --help
```

`npm run smoke` inspecte le contenu du package, l’installe dans un répertoire
temporaire avec `--omit=dev`, puis vérifie le bin, `npm exec` (la voie utilisée par
npx), l’API et le MCP stdio. La CI répète ces étapes sur chaque combinaison OS/Node.
Le test d’étiquetage dans un vrai navigateur est conservé ; il est ignoré si Edge
est absent. Les autres tests n’exigent ni boîte mail, ni réseau JEV, ni navigateur.

Les scripts historiques ci-dessous restent utilisables dans le dépôt source.
La licence est provisoirement `UNLICENSED` : choisir une licence avant la première
publication publique. Aucune publication, release ni push n’est automatisé.

## Organisation du dépôt historique

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

Pour comparer JEV à votre propre jugement (étape nécessaire avant de fixer les
seuils de `config/jev.json`) :

```bash
node settings/server.mjs
```

puis ouvrir http://127.0.0.1:4177/labeling-component/labeling-component.html
(lien « Étiqueter JEV » du dashboard). Chaque mail est présenté sans la réponse
de JEV ; les valeurs préremplies sont neutres (« non », `information`, 0), donc
une alerte banale se valide d'un appui sur Entrée. `S` passe, `?` note « je ne
sais pas ». La réponse de JEV n'apparaît qu'après enregistrement. Les cas que JEV
juge rares passent en premier. Les étiquettes vont dans `data/jev-labels.json`.

Après ~60 étiquettes :

```bash
node ingest/jev-agreement.mjs
```

Le rapport donne l'accord par question, les confusions, les erreurs sûres
d'elles, et pour chaque question oui/non le plus haut seuil qui ne rate aucun
« oui » humain. Il n'écrit rien : recopier un seuil reste votre décision.

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
