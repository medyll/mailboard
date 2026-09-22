Tâche planifiée « Veille emploi — mailboard ». Session fraîche : aucun souvenir des runs précédents.

Dossier de travail : le dépôt mailboard, `{{MAILBOARD_DIR}}`. Toutes les commandes et tous les chemins ci-dessous s'y rapportent.

Contrat : `AGENTS.md` du dépôt. Le lire en premier ; en cas de désaccord, il l'emporte sur ce prompt.

## 1. Requêtes

Lire `config/criteria.json`. Pour chaque critère dont `enabled` n'est pas `false`, prendre `gmailQuery.gmail` et remplacer `{windowHours}` par `defaults.windowHours` (12 si absent). Ne jamais inventer ni réécrire de requête.

## 2. Collecte Gmail

Avec le connecteur Gmail, lancer chaque requête (recherche de threads). Pour chaque mail retenu, récupérer le message complet et garder son corps en texte brut. Un mail trouvé par deux critères n'apparaît qu'une fois, sous le premier critère.

## 3. Run

Écrire **un seul** fichier `data/runs-inbox/run-<YYYYMMDD-HHmm>--gmail-primary.json` (heure locale), au format v2 de `ingest/schema.md` :

```json
{
  "schemaVersion": 2,
  "runAt": "<ISO 8601>",
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
- N'écrire nulle part ailleurs que dans `data/runs-inbox/`. Ne modifier ni le code, ni `config/`, ni les fichiers `data/*.jsonl`.

## 3 bis. Rattrapage des corps

Lancer `node ingest/missing-bodies.mjs --source gmail-primary --limit 20`. La sortie est une ligne JSON dont `items` liste des messages Gmail déjà connus mais sans corps.

Si `items` n'est pas vide : pour chacun, récupérer le message par son `id` avec le connecteur Gmail (format texte brut), puis écrire **un seul** fichier `data/runs-inbox/backfill-<YYYYMMDD-HHmm>--gmail-primary.json` :

```json
{
  "schemaVersion": 2,
  "kind": "backfill",
  "runAt": "<ISO 8601>",
  "source": { "sourceId": "gmail-primary", "channelKind": "mailbox", "accessMode": "connector", "provider": "gmail" },
  "collector": { "name": "scheduled-task", "status": "ok" },
  "messages": [{ "id": "<id>", "body": "<corps en texte brut>" }]
}
```

Un message introuvable ou sans corps est simplement omis. Ne rien écrire si `items` est vide. Ce rattrapage ne compte pas dans la réponse finale.

## 4. Cycle

Lancer `node orchestrator/run-cycle.mjs`. Il collecte les autres canaux (Proton via Edge), ingère une seule fois et décide de la notification. Il peut prendre plusieurs minutes ; ne pas l'interrompre.

## 5. Réponse finale

Lire la dernière ligne de sortie : un objet JSON `mailboard.cycle.result`.

- `notify` vaut `true` : commencer par « Du nouveau : » suivi de `message`, puis une ligne par nouveau mail Gmail (expéditeur — objet — l'essentiel), groupées par catégorie.
- `notify` vaut `false` : répondre « Rien de nouveau. », plus une ligne listant les canaux en échec s'il y en a.
- `ok` vaut `false`, ou la commande n'a pas pu tourner : commencer par « Veille en échec : » suivi de la cause.

Répondre en français, de façon factuelle et concise.
