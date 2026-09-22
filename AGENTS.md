# jobmailboard — veille emploi

Suivi local des mails emploi repérés par la tâche planifiée « Veille emploi ».
Pas de serveur, pas de dépendances : du JSONL sur disque + un dashboard statique.

## Rôle de l'agent pendant un run

1. Lancer une recherche Gmail **par critère activé** dans
   [config/criteria.json](config/criteria.json), sur la fenêtre qui y est définie
   (12 h par défaut). Ne jamais réécrire les requêtes ici : elles vivent dans ce
   fichier, avec `{windowHours}` substitué à l'exécution.
2. Pour chaque mail retenu, récupérer le **corps** (`get_message`) et le mettre dans
   `body`. Sans lui, le mail n'est pas lisible ni cherchable dans le dashboard.
3. Écrire **un seul fichier** par canal dans `data/runs-inbox/`, respectant
   [ingest/schema.md](ingest/schema.md). Écrire le fichier même si aucun mail n'est
   trouvé (`"messages": []`) — un run vide documente la couverture. La `category`
   de chaque message doit être l'`id` d'un critère de `config/criteria.json`.
4. Lancer ensuite `node orchestrator/run-cycle.mjs`. Il collecte les canaux
   browser, ingère une seule fois et écrit en dernière ligne un objet
   `mailboard.cycle.result`.
5. Lire cet objet. Notifier **seulement** si `notify` vaut `true`, avec le texte
   de `message`. Les doublons ne déclenchent rien : la déduplication par id est
   la source de vérité, pas la fenêtre temporelle.

## Cycle d'orchestration

[orchestrator/run-cycle.mjs](orchestrator/run-cycle.mjs) porte ce cycle ; aucun
collecteur n'appelle l'ingesteur. Détails dans
[orchestrator/README.md](orchestrator/README.md).

1. **Préparer** : charger les canaux activés et fixer une fenêtre commune.
2. **Collecter** : lancer chaque canal séparément. Les canaux qui partagent un
   profil Edge passent en série avec
   `pwsh -File collectors/browser-mail/run.ps1 --source <sourceId>` ; les autres
   peuvent tourner en parallèle.
3. **Constater** : attendre la fin de chaque tentative. Un canal en échec écrit
   quand même son run v2 avec `messages: []` et un `collector.status` explicite ;
   s'il n'a rien pu écrire (Edge absent, port CDP muet, délai dépassé),
   l'orchestrateur écrit ce run à sa place. Le cycle continue avec les autres
   canaux.
4. **Ingérer** : lancer une seule commande `node ingest/ingest.mjs --json` après
   toutes les tentatives.
5. **Notifier** : prendre la décision depuis l'objet
   `mailboard.ingest.result`, jamais depuis le nombre de résultats collectés.
   L'orchestrateur la reporte dans `mailboard.cycle.result.notify`.

`node orchestrator/run-cycle.mjs --retry-failed` relance seulement les canaux
browser en échec au cycle précédent (`data/cycle-state.json`).

Si le cycle s'arrête avant l'ingestion, les runs restent dans
`data/runs-inbox/` et le prochain cycle les reprend. Si l'ingestion s'arrête
avant l'archivage, elle conserve également les fichiers dans l'inbox. Un
`runId` déjà présent dans `data/runs.jsonl` sera seulement archivé au passage
suivant, sans créer de second run canonique.

## Invariants

- La déduplication se fait sur `sourceId` + `id` externe (`key`), jamais sur
  l'objet ou l'expéditeur. Un run sans `source` est rattaché à `gmail-legacy`.
- `config/criteria.json` dit ce qu'on cherche, `config/preferences.json` ce qu'on
  veut. Une préférence rédhibitoire signale un message, elle ne le supprime
  jamais : la décision reste à l'humain.
- Les critères de tri, les canaux et les questions JEV vivent dans `config/`.
  Ajouter un critère = éditer `config/criteria.json` puis `--rebuild` ; aucun code
  à toucher, ni dans l'ingesteur ni dans le dashboard.
- Le CV de `profile/` ne quitte jamais la machine : seul `profile/profile.jev.md`,
  expurgé, est transmis à un modèle.
- `data/messages.jsonl` est append-only en pratique ; il n'est réécrit en entier que
  pour mettre à jour `lastSeenAt` / `seenCount`. Ne jamais l'éditer à la main.
- `dashboard/data.js` et `dashboard/bodies.js` sont **générés**. Toute modification
  manuelle sera écrasée au run suivant.
- Les corps sont stockés dans `data/bodies.jsonl`, séparés de l'index : `messages.jsonl`
  reste léger et lisible même avec un an d'historique. Un corps déjà stocké n'est jamais
  écrasé par un run ultérieur.
- L'état « traité » vit dans le localStorage du navigateur, pas dans `data/`. Il ne
  survit pas à un changement de navigateur — c'est assumé, ça évite d'avoir à écrire
  depuis la page.
