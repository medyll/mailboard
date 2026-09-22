# Contrat de sortie d'un run

Chaque collecteur écrit **un fichier JSON par run** dans `data/runs-inbox/`.
`ingest.mjs` le consomme puis le déplace dans `data/runs-archive/`.

```text
run-<YYYYMMDD-HHmm>.json                      source unique (historique)
run-<YYYYMMDD-HHmm>--<sourceId>.json          multicanal
```

Le nom du fichier est le `runId`. Deux collecteurs qui tournent sur la même
fenêtre écrivent donc deux fichiers, chacun avec sa propre couverture.

## Version 2 — multicanal

```json
{
  "schemaVersion": 2,
  "runAt": "2026-09-22T19:00:00.000Z",
  "windowHours": 12,
  "source": {
    "sourceId": "proton-perso",
    "channelKind": "mailbox",
    "accessMode": "browser",
    "provider": "proton"
  },
  "collector": {
    "name": "edge-mail-jev",
    "version": "0.1.0",
    "status": "ok"
  },
  "coverage": {
    "folder": "inbox",
    "from": "2026-09-22T07:00:00.000Z",
    "to": "2026-09-22T19:00:00.000Z",
    "complete": true,
    "itemsInspected": 24
  },
  "queries": {
    "emploi": "candidature OR poste OR entretien",
    "france-travail": "France Travail OR Pôle emploi"
  },
  "messages": [
    {
      "id": "provider-message-id",
      "identityQuality": "provider-id",
      "category": "emploi",
      "date": "2026-09-22T16:42:00.000Z",
      "from": "Recrutement ACME <user-07@example.test>",
      "subject": "Votre candidature - Développeur front",
      "summary": "Convocation à un entretien visio le 25/09 à 14h.",
      "body": "Bonjour,\n\nSuite à votre candidature…",
      "link": "https://mail.proton.me/u/0/inbox/…"
    }
  ]
}
```

## Règles

- **Clé de déduplication : `sourceId` + `id`.** Un identifiant externe n'est
  unique que dans son canal ; deux boîtes différentes peuvent exposer le même.
  L'ingestion calcule `key = "<sourceId>:<id>"`.
- `source` absent → le run est traité comme `gmail-legacy`, ce qui préserve
  l'identité des messages ingérés avant le multicanal.
- `category` doit être l'`id` d'un critère de `config/criteria.json`. Une
  catégorie inconnue passe par les `aliases`, puis retombe sur `autre` — elle
  n'est jamais perdue.
- `identityQuality` ∈ `provider-id` | `conversation-id` | `fingerprint`. Un
  numéro d'élément DOM ou une position dans une liste n'est jamais un `id`.
- `collector.status` ∈ `ok` | `partial` | `needs_user` | `wrong_account` |
  `unavailable` | `error`. Un run en échec garde `messages: []` et documente
  quand même sa couverture.
- `summary` : 1 à 2 phrases factuelles, pas d'interprétation.
- `body` : texte brut de préférence, HTML accepté (converti à l'ingestion).
  Stocké dans `data/bodies.jsonl`, **pas** dans `messages.jsonl`, tronqué à
  12 000 caractères. Sans lui, seuls objet, expéditeur et résumé sont cherchables.
- Un `body` peut arriver dans un run ultérieur ; un corps déjà stocké n'est
  jamais écrasé.
- `messages: []` est valide — un run vide prouve que la veille a tourné, et le
  dashboard affiche les trous de couverture.
- Optionnels : `threadId`, `link`, `summary`, `body`, `queries`, `coverage`,
  `collector`, `jev`.

## Run de rattrapage des corps

Un run v2 avec `"kind": "backfill"` n'apporte que des corps pour des messages
**déjà connus** du même canal. Il ne crée aucun message, ne touche ni
`seenCount` ni `lastSeenAt`, n'entre pas dans `runs.jsonl` (ce n'est pas une
observation de la boîte) et il est archivé comme les autres. Un `id` inconnu est
ignoré avec un avertissement.

```json
{
  "schemaVersion": 2,
  "kind": "backfill",
  "runAt": "2026-09-22T19:00:00.000Z",
  "source": { "sourceId": "gmail-primary", "channelKind": "mailbox", "accessMode": "connector", "provider": "gmail" },
  "collector": { "name": "scheduled-task", "status": "ok" },
  "messages": [{ "id": "provider-message-id", "body": "Bonjour,\n\n…" }]
}
```

Nom conseillé : `backfill-<YYYYMMDD-HHmm>--<sourceId>.json`. Les messages à
rattraper se listent avec
`node ingest/missing-bodies.mjs --source <sourceId> --limit 20` (du plus récent
au plus ancien).

## Version 1 — toujours acceptée

Un run sans `schemaVersion` ni `source` reste valide : c'est le format Gmail
d'origine, rattaché au canal `gmail-legacy`.

```json
{
  "runAt": "2026-09-22T07:00:00+02:00",
  "windowHours": 12,
  "queries": { "emploi": "newer_than:12h (candidature OR poste)" },
  "messages": [{ "id": "18f2c9a1b3d4e5f6", "category": "emploi", "…": "…" }]
}
```

## Champs ajoutés par l'ingestion

| Champ | Sens |
|---|---|
| `key` | `<sourceId>:<id>` — identité canonique, clé de déduplication |
| `sourceId` | canal d'origine (`gmail-legacy` par défaut) |
| `provider` | fournisseur déclaré par le run |
| `firstSeenAt` | horodatage du run qui a découvert le message |
| `lastSeenAt` | horodatage du dernier run où il est réapparu |
| `seenCount` | nombre de runs l'ayant retourné |
| `runId` | run de découverte |
| `hasBody` | un corps est stocké pour ce message |

## Bloc `jev` (facultatif)

Un message peut porter un objet `jev` produit par l'enrichissement décrit dans
[JEV_INTEGRATION.md](../JEV_INTEGRATION.md) : `status`, `questionSet`, `model`,
`evaluatedAt`, `inputFingerprint`, `answers`. Il est recopié tel quel et
n'influence ni la déduplication ni la conservation d'un message.
