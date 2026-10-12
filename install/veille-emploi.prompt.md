Tâche planifiée « Veille emploi — mailboard ». Session fraîche : aucun souvenir des runs précédents.

Dossier de travail : le dépôt mailboard, `{{MAILBOARD_DIR}}`. Toutes les commandes et tous les chemins ci-dessous s'y rapportent.

Contrat : `AGENTS.md` du dépôt. Le lire en premier ; en cas de désaccord, il l'emporte sur ce prompt.

Règle shell : ne jamais utiliser `node -e`, `node -p`, `date` ni de script inline. Lancer uniquement les scripts du dépôt cités ici (`node ingest/...`, `node orchestrator/...`), depuis le shell Bash, avec exactement les arguments indiqués : une commande par appel, sans `;`, `&&`, pipe, redirection (`>`, `<`), heredoc (`<<EOF`) ni `wc`/`cat`/`head`. Ne rien lire ni écrire hors du dépôt (pas de `$TEMP`). Lire les fichiers avec l'outil Read, écrire avec l'outil Write. Toute autre forme déclenche une demande d'autorisation et bloque la tâche.

## 1. Requêtes

Lancer `node ingest/gmail-queries.mjs`. La sortie est une ligne JSON : `queries` (id du critère → requête Gmail prête, `{windowHours}` déjà remplacé), `windowHours`, `runAt` (ISO 8601 local) et `stamp` (`YYYYMMDD-HHmm`). Ne jamais inventer ni réécrire de requête.

## 2. Collecte Gmail

Avec le connecteur Gmail, lancer chaque requête (recherche de threads). Pour chaque mail retenu, récupérer le message complet et garder son corps en texte brut. Un mail trouvé par deux critères n'apparaît qu'une fois, sous le premier critère.

## 3. Run

Écrire **un seul** fichier `data/runs-inbox/run-<stamp>--gmail-primary.json` (`stamp` et `runAt` de l'étape 1), au format v2 de `ingest/schema.md` :

```json
{
  "schemaVersion": 2,
  "runAt": "<runAt>",
  "windowHours": 12,
  "source": { "sourceId": "gmail-primary", "channelKind": "mailbox", "accessMode": "connector", "provider": "gmail" },
  "collector": { "name": "scheduled-task", "status": "ok" },
  "queries": { "<id du critère>": "<requête lancée>" },
  "messages": [
    {
      "id": "<id du message Gmail>",
      "threadId": "<id du thread>",
      "category": "<id du critère>",
      "date": "<ISO 8601>",
      "from": "<expéditeur>",
      "subject": "<objet>",
      "summary": "<1 à 2 phrases factuelles>",
      "body": "<corps en texte brut>"
    }
  ]
}
```

- Écrire le fichier même sans aucun mail (`"messages": []`).
- Si le connecteur Gmail échoue : `"messages": []`, `collector.status` à `"unavailable"` et l'erreur dans `collector.note`.
- N'écrire nulle part ailleurs que dans `data/runs-inbox/` (seule exception : `data/jev-review.tmp.json`, étape 4 bis). Ne modifier ni le code, ni `config/`, ni les fichiers `data/*.jsonl`.

## 3 bis. Rattrapage des corps

Lancer `node ingest/missing-bodies.mjs --source gmail-primary --limit 20`. La sortie est une ligne JSON dont `items` liste des messages Gmail déjà connus mais sans corps.

Si `items` n'est pas vide : pour chacun, récupérer le message par son `id` avec le connecteur Gmail (format texte brut), puis écrire **un seul** fichier `data/runs-inbox/backfill-<stamp>--gmail-primary.json` :

```json
{
  "schemaVersion": 2,
  "kind": "backfill",
  "runAt": "<runAt>",
  "source": { "sourceId": "gmail-primary", "channelKind": "mailbox", "accessMode": "connector", "provider": "gmail" },
  "collector": { "name": "scheduled-task", "status": "ok" },
  "messages": [{ "id": "<id>", "body": "<corps en texte brut>" }]
}
```

Un message introuvable ou sans corps est simplement omis. Ne rien écrire si `items` est vide. Ce rattrapage ne compte pas dans la réponse finale.

## 4. Cycle

Lancer, depuis le shell Bash : `MAILBOARD_PWSH=pwsh node orchestrator/run-cycle.mjs`. L'orchestrateur collecte les autres canaux — Proton par IMAP via Proton Mail Bridge (`collectors/proton-bridge/collect.mjs`, Bridge doit tourner et être connecté), les éventuels canaux navigateur via Edge (la variable fait passer ceux-ci par `collectors/browser-mail/run.ps1`) —, ingère une seule fois et décide de la notification. Il peut prendre plusieurs minutes ; ne pas l'interrompre. Si le canal Proton échoue en authentification, le signaler : Bridge est probablement fermé.

## 4 bis. Relecture JEV

Mesure continue de JEV contre la lecture du corps (voir `JEV_INTEGRATION.md`, « Relecture outillée »). Deux lots de 5 : d'abord `node ingest/jev-review.mjs --limit 5 --order uncertain --out data/jev-review.queue.json`, puis, une fois le premier enregistré, `node ingest/jev-review.mjs --limit 5 --order recent --out data/jev-review.queue.json`.

Pour chaque lot :
- La commande n'affiche que `{ out, items }` (nombre de mails). Si `items` vaut 0, passer. Sinon lire `data/jev-review.queue.json` avec l'outil Read : `questions` (identifiant, type, texte, options ou niveaux) et `items` (mails avec leur corps). Les réponses de JEV n'y sont pas, volontairement : ne pas les chercher ailleurs.
- Pour les questions marquées `requiresProfile`, lire avec l'outil Read `profile/profile.jev.md` (digest expurgé du CV) et `config/preferences.json` (technologies souhaitées ou à éviter).
- Répondre depuis le mail seul : `noul` → `true`/`false`, `choice` → une clé de `options`, `score` → un entier de 0 au dernier niveau, `null` si la question est sans objet ou indécidable.
- Enregistrer : écrire avec l'outil Write `data/jev-review.tmp.json` (écraser s'il existe) contenant `{"model": "<ton modèle>", "labels": [{"key": "<key>", "answers": {…}}]}`, puis lancer `node ingest/jev-review.mjs --save data/jev-review.tmp.json`.

Si `items` est vide, passer. Une erreur de relecture n'empêche pas la réponse finale ; elle ne se mentionne que si elle se répète.

## 5. Réponse finale

Reprendre la dernière ligne de sortie de l'étape 4 : un objet JSON `mailboard.cycle.result`.

- `notify` vaut `true` : commencer par « Du nouveau : » suivi de `message`, puis une ligne par nouveau mail Gmail (expéditeur — objet — l'essentiel), groupées par catégorie.
- `notify` vaut `false` : répondre « Rien de nouveau. », plus une ligne listant les canaux en échec s'il y en a.
- `ok` vaut `false`, ou la commande n'a pas pu tourner : commencer par « Veille en échec : » suivi de la cause.

Répondre en français, de façon factuelle et concise.
