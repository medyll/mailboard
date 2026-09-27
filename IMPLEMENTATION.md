# Bilan — @medyll/jobmailboard 0.1.0

Le dépôt est devenu un package npm exécutable, avec CLI, API publique et serveur
MCP stdio. Les fonctionnalités existantes sont conservées. Aucune publication npm,
aucun push ni aucune release n’ont été exécutés pendant l’implémentation.

Le workflow de publication ajouté ensuite suit les projets idae et acp-team :
push sur `main` ou lancement manuel sur `main`, validation complète via la CI
réutilisable, puis `@medyll/idae-pnpm-release@1.0.47`. Le helper gère version,
changelog, commit, tag et publication. Le secret est `NPM_TOKEN`, avec
`NPM_TOKEN_2026` en repli. Le lockfile npm est synchronisé après la release.

## Fichiers créés et modifiés

| Ensemble | Fichiers | Rôle |
| --- | --- | --- |
| Package | `package.json`, `package-lock.json`, `tsconfig.json`, `bin/jobmailboard.js` | Métadonnées npm, dépendances verrouillées, compilation et executable |
| Cœur | `src/core/index.ts`, `src/core/models/index.ts`, `src/core/services/mailboard.ts`, `ingestion.mjs`, `missing-bodies.mjs`, `jev-backfill.mjs`, `jev-agreement.mjs` dans `src/core/services/` | API commune et métier extrait des scripts historiques |
| Adaptateurs et configuration | `src/adapters/logger.ts`, `src/adapters/browser-collector.ts`, `src/config/workspace.ts`, `src/config/version.ts`, `src/index.ts` | Logs, collecte navigateur, emplacement utilisateur, version et exports publics |
| CLI | `src/cli/index.ts`, `src/cli/commands/parse.ts` | Parsing strict, aide/version et commandes métier |
| MCP | `src/mcp/index.ts`, `src/mcp/server.ts`, `src/mcp/tools/index.ts`, `src/mcp/resources/index.ts` | Transport stdio, huit tools et ressource de réglages |
| Configuration distribuée | `assets/config/criteria.json`, `preferences.json`, `jev.json`, `channels.local.json` | Valeurs génériques ; aucun compte personnel ; JEV désactivé |
| Build et validation | `scripts/build.mjs`, `scripts/test.mjs`, `scripts/smoke-package.mjs`, `tests/core/mailboard.test.mjs`, `tests/cli/cli.test.mjs`, `tests/mcp/mcp.test.mjs` | Assets, tests existants et nouveaux, test du vrai package installé |
| CI et publication | `.github/workflows/ci.yml` remplace `.github/workflows/test.yml`, `.github/workflows/release.yml`, `.idae-pnpm-release` | Windows/Linux/macOS × Node 22/24, puis release sur main |
| Compatibilité historique | `ingest/ingest.mjs`, `ingest/missing-bodies.mjs`, `ingest/jev-backfill.mjs`, `ingest/jev-agreement.mjs` | Entrées conservées, devenues des adaptateurs du cœur |
| Modules existants adaptés | `config/load.mjs`, `ingest/jev-labels.mjs`, `orchestrator/run-cycle.mjs`, `settings/server.mjs`, `collectors/browser-mail/collect.mjs` | Répertoires explicites, réutilisation des services, configuration propre à chaque espace |
| Documentation | `README.md`, `.gitignore`, `IMPLEMENTATION.md` | Usage, architecture, limites, fichiers générés ignorés et bilan |

Le fichier préexistant non suivi `.claude/settings.local.json` est resté intact.
Les données réelles du dépôt et les projections générées du dashboard n’ont pas
été éditées manuellement.

## Décisions d’architecture

`Mailboard` est l’API publique commune. La CLI et le MCP appellent ses méthodes
directement ; aucun handler MCP ne lance la CLI. L’ingestion, le rattrapage des
corps et les opérations JEV ont été extraits sans réécriture du métier. Les
modules existants de configuration, d’orchestration et de réglages sont réutilisés.
Le build accepte leur JavaScript ESM et compile les nouvelles interfaces TypeScript.

L’API garde la déduplication `sourceId + id`, les corps séparés et immuables,
les runs archivés et la décision de notification issue de l’ingestion. Les tests
vérifient notamment qu’un doublon ne déclenche pas de notification.

Le SDK officiel est `@modelcontextprotocol/server` 2.1.0, avec Zod pour les entrées.
La version stable a été vérifiée sur npm et dans la
[documentation officielle v2](https://ts.sdk.modelcontextprotocol.io/v2/).
Le client SDK n’est qu’une dépendance de développement. Aucun prompt MCP vide
ni répertoire artificiel n’a été ajouté.

Les huit tools sont `list_messages`, `get_message`, `missing_bodies`,
`collection_queries`, `ingest_runs`, `rebuild_dashboard`, `run_cycle` et
`jev_backfill`. La ressource `jobmailboard://settings` renvoie la configuration
brute, sans résolution des secrets référencés par variable d’environnement.

Le logger du cœur écrit sur stderr. Le démarrage, les appels et les erreurs MCP
sont testés via le vrai transport stdio, y compris la détection des erreurs de
décodage du flux. stdout reste réservé au protocole.

Les données vont dans un espace utilisateur portable ou un répertoire explicite
`--root`/`MAILBOARD_ROOT`. L’initialisation conserve les fichiers existants et
refuse le répertoire du package comme espace d’écriture. Les préférences sont
vides au départ ; l’envoi du profil et JEV sont désactivés. `--dry` n’initialise
pas l’espace et ne crée aucun fichier.

La collecte Node fonctionne avec un navigateur CDP déjà lancé. Le wrapper
PowerShell Windows reste disponible via `MAILBOARD_PWSH`. La navigation JEV
conserve son pilote Python/uv facultatif. Ces dépendances ne sont pas nécessaires
à la CLI, au MCP, à l’ingestion ni au dashboard.

## Validation exécutée

| Commande ou vérification | Résultat |
| --- | --- |
| `npm install` | OK ; dépendances installées et lockfile créé |
| `npm ci` | OK ; installation reproductible ; audit sans vulnérabilité signalée |
| `npm run typecheck` | OK |
| `npm run build` | OK ; JavaScript, déclarations et assets |
| `npm test` sur Node 24 | **67/67 réussis**, aucun ignoré |
| Même suite sur Node 22.23.3 | **67/67 réussis**, aucun ignoré |
| `npm pack --json` | OK ; `medyll-jobmailboard-0.1.0.tgz` |
| Inspection réelle du gzip/tar | **78 fichiers**, 33 fichiers JS/MJS, 28 déclarations ; aucun JSONL personnel, CV, test, source TS ou projection de mails |
| `npm run smoke` sur Node 22.23.3 | OK |
| `npm run smoke` sur Node 24.21.0 | OK |
| `git diff --check` | OK |

L’archive finale fait **89 405 octets**. Les smoke tests installent un `.tgz` dans
un projet temporaire avec `--omit=dev`, puis exécutent `--help`, `--version`,
`init`, `cycle`, le shim via `npm exec`, l’API importée, le serveur HTTP et le MCP
stdio. Ils contrôlent aussi la liste des fichiers distribués.

Les tests préexistants ont tous été conservés, dont le parcours d’étiquetage réel
dans Edge. Les nouvelles vérifications couvrent la lecture et la recherche des
corps, les erreurs de parsing, l’initialisation sans écrasement, le mode dry,
les réglages sauvegardés et reconstruits, la collecte sur canal inconnu et les
appels MCP essentiels.

npm n’étant pas exposé dans le terminal initial, l’outillage a été amorcé puis les
smoke tests ont utilisé Node LTS/npm 11. Un premier essai sans projet temporaire
explicite avait installé la dépendance de test au préfixe npm utilisateur : cette
entrée a été retirée, les dépendances préexistantes ont été conservées, et le
smoke test a été corrigé pour isoler son projet et son environnement.

## Limites et étapes avant publication

La CI est configurée pour six combinaisons : Windows, Ubuntu et macOS, chacune
avec Node 22 et 24, les deux lignes LTS pertinentes selon le
[calendrier officiel Node.js](https://nodejs.org/en/about/previous-releases).
Elle exécute installation, typecheck, build, tests, pack et smoke. Elle n’a pas
encore été lancée sur GitHub : aucun push n’était autorisé. Les validations locales
ont été réalisées sous Windows ; Linux et macOS seront vérifiés par la matrice.

Les contraintes préexistantes restent documentées : Gmail nécessite un agent ou
un connecteur pour déposer les runs ; le fournisseur navigateur implémenté est
Proton ; `--nav jev` nécessite Python/uv ; l’état « traité » demeure dans le
localStorage du navigateur. Les mutations d’une instance sont mises en file,
mais plusieurs processus ne doivent pas écrire simultanément dans le même espace.

Avant la première publication :

1. Choisir la licence ; les métadonnées portent provisoirement `UNLICENSED`.
2. Faire valider la matrice CI après un futur push autorisé.
3. Configurer `NPM_TOKEN` ou `NPM_TOKEN_2026` et les droits du bot sur `main`.
   Un push sur `main` ou le lancement manuel du workflow `Release` publiera après
   validation complète, avec `publishConfig.access: public`.

Les commandes `npx @medyll/jobmailboard` et `npx @medyll/jobmailboard mcp` sont
prêtes côté package et deviendront disponibles depuis le registre après cette
publication. Le README contient l’exemple de configuration MCP et les précisions
pour les clients Windows qui lancent des fichiers `.cmd` sans shell.
