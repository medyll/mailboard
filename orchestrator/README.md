# orchestrator

Tient le cycle complet décrit dans [AGENTS.md](../AGENTS.md) : collecter,
constater, ingérer une fois, décider de la notification.

```text
agent (tâche planifiée) : collecte Gmail via connecteur → data/runs-inbox/
node orchestrator/run-cycle.mjs
  ├─ canaux browser, en série (profil Edge partagé) → run.ps1 --source <id>
  ├─ canal sans run après tentative → run d'échec écrit par l'orchestrateur
  ├─ canaux connector : vérifie seulement que leur run est arrivé
  ├─ node ingest/ingest.mjs --json (une seule fois)
  └─ dernière ligne : mailboard.cycle.result
```

## Usage

| commande | effet |
|---|---|
| `node orchestrator/run-cycle.mjs` | cycle complet |
| `node orchestrator/run-cycle.mjs --retry-failed` | relance seulement les canaux browser en échec au cycle précédent, puis ingère |
| `node orchestrator/run-cycle.mjs --skip-collect` | ingère ce qui attend dans l'inbox, sans collecter |

Code de sortie : `0` si l'ingestion a réussi, même si un canal a échoué (l'échec
est tracé par un run et dans le résultat). `1` si l'ingestion a échoué ; les runs
restent alors dans l'inbox pour le cycle suivant.

## Résultat

```json
{
  "type": "mailboard.cycle.result",
  "ok": true,
  "notify": true,
  "added": 3,
  "message": "Mailboard : 3 nouveau(x) message(s) — canal en échec : proton-perso (error)",
  "channels": { "proton-perso": "error", "gmail-primary": "delegated" },
  "ingest": { "type": "mailboard.ingest.result", "added": 3, "…": "…" }
}
```

Notifier **seulement** si `notify` vaut `true` ; `message` est le texte prêt à
envoyer. Statuts de canal : ceux de `collector.status`
([ingest/schema.md](../ingest/schema.md)), plus `delegated` (run connector
présent) et `missing` (run connector absent).

## État

`data/cycle-state.json` est réécrit à chaque étape : un cycle interrompu montre
où il s'est arrêté. `--retry-failed` le relit pour choisir les canaux à relancer.

## Variables

- `MAILBOARD_CHANNEL_TIMEOUT_MS` : délai maximal par canal browser (5 min par défaut).
- `MAILBOARD_PWSH` : exécutable PowerShell sous Windows (`pwsh` par défaut).
- `MAILBOARD_ROOT` : racine des données (tests).

## Tests

`node --test orchestrator/run-cycle.test.mjs` — collecteur simulé, vrai
ingesteur dans un répertoire temporaire.
