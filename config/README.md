# Configuration

Tout ce qui change d'une machine, d'un compte ou d'une recherche d'emploi à
l'autre vit ici. Aucun code n'est à modifier pour ajouter un critère de tri, une
boîte mail ou un fournisseur.

| Fichier | Versionné | Rôle |
|---|---|---|
| `criteria.json` | oui | **critères de tri** : ce qu'on cherche, comment ça s'appelle, de quelle couleur c'est |
| `preferences.json` | oui | **pro / cons** : ce qu'on veut, ce qu'on refuse |
| `channels.example.json` | oui | modèle de registre de canaux, sans donnée personnelle |
| `channels.local.json` | **non** | canaux réellement activés sur cette machine |
| `jev.json` | oui | jeu de questions JEV, seuils, modèle |
| `load.mjs` | oui | chargeur unique — l'ingesteur et les collecteurs passent par lui |

L'adaptateur qui parle à TypeSafe est [`ingest/jev.mjs`](../ingest/jev.mjs) : il
traduit le vocabulaire de `jev.json` (primitive, texte, options, niveaux) vers
`POST /v1/systemone`. Changer de fournisseur ne devrait toucher que ce fichier.

## Ajouter ou modifier un critère de tri

Éditer `criteria.json`, puis `node ingest/ingest.mjs --rebuild`. Le dashboard
reprend libellé, couleur et filtre sans retouche de code ni de CSS.

```json
{
  "id": "veille-tech",
  "label": "Veille technique",
  "enabled": true,
  "color": { "light": "#7048e8", "dark": "#b197fc" },
  "profileMatch": false,
  "queries": {
    "gmail": "newer_than:{windowHours}h (newsletter OR conférence)",
    "keywords": ["newsletter", "conférence"]
  }
}
```

- `{windowHours}` est substitué à l'exécution : la fenêtre se règle à un seul endroit.
- `queries.<provider>` : une requête par fournisseur, dans **sa** syntaxe. Un
  fournisseur sans entrée est simplement ignoré pour ce critère.
- `queries.keywords` sert aux collecteurs qui n'ont pas de moteur de recherche
  (extraction depuis une liste).
- `profileMatch: true` active les questions d'adéquation au CV pour ce critère.
- `enabled: false` retire le critère sans perdre sa formulation.

**Renommer plutôt que casser.** Un critère supprimé laisse des messages déjà
classés sous l'ancien nom. Ajouter une entrée dans `aliases` les rattache au
critère actuel, sans réécrire `data/messages.jsonl` :

```json
"aliases": { "candidatures": "emploi", "recruteurs": "emploi" }
```

## Ajouter un pro ou un con

`criteria.json` dit **ce qu'on cherche**. Le CV dit **ce qu'on sait faire**.
`preferences.json` dit **ce qu'on veut** — et c'est une autre question : un
langage peut figurer au parcours sans qu'on souhaite y revenir.

Une entrée suffit, puis `node ingest/ingest.mjs --rebuild` :

```json
{
  "id": "rust",
  "kind": "pro",
  "strength": "mild",
  "label": "Rust",
  "match": { "keywords": ["rust", "tokio"] }
}
```

- `kind` : `pro` attire, `con` repousse.
- `strength` : `blocker` (4 points), `strong` (2), `mild` (1).
- `blocker` **signale**, ne supprime pas. Le dashboard propose « masquer les
  rédhibitoires » ; c'est une case que l'on coche, pas une décision prise à
  votre place. Une préférence mal formulée ne doit pas faire disparaître une
  offre en silence.
- Le calcul est local et déterministe : aucun appel, aucun coût. Les mots-clés
  sont comparés en minuscules à l'expéditeur, l'objet et le résumé.

Les préférences sont réévaluées **à chaque `--rebuild`**, sur tout l'historique.
Éditer le fichier suffit donc à reclasser un an de messages, sans réécrire une
ligne de `data/`.

Elles accompagnent aussi l'appel JEV métier, sous forme de deux listes de
libellés (`wants`, `avoids`). Sans elles, `roleFit` noterait au plus haut une
offre Java, puisque le parcours en contient.

Un script, une skill ou un serveur MCP peut écrire dans ce fichier : c'est du
JSON plat, sans dépendance, et la seule contrainte est de garder les `id`
uniques.

## Déclarer un canal

Copier `channels.example.json` en `channels.local.json` et adapter. Trois axes
indépendants décrivent une source :

- `channelKind` — `mailbox`, `feed`, `messaging`, `file`
- `accessMode` — `connector`, `api`, `browser`, `drop`
- `provider` — `gmail`, `proton`, `outlook`, `rss`…

Ils sont orthogonaux : `gmail` + `connector` et `gmail` + `browser` sont deux
canaux valides du même fournisseur. Chaque canal porte un `sourceId` stable, qui
sert de préfixe à la clé de déduplication — deux boîtes différentes qui exposent
le même identifiant externe ne se confondent jamais.

`linkTemplate` (facultatif) reconstruit le lien d'un message quand le collecteur
n'en fournit pas : `"https://mail.proton.me/u/0/inbox/{id}"`.

## Variables d'environnement

Aucun secret ne figure dans les fichiers de configuration. Une valeur de la forme
`"env:NOM"` y est remplacée au chargement par `process.env.NOM`.

| Variable | Défaut | Rôle |
|---|---|---|
| `TYPESAFE_API_KEY` | — | clé JEV. Absente = `jev.status: skipped`, l'ingestion continue |
| `MAILBOARD_JEV` | valeur de `jev.json` | `1` active l'enrichissement, `0` le coupe |
| `MAILBOARD_JEV_MODEL` | `jev.json` | épingler une version de modèle |
| `MAILBOARD_JEV_TIMEOUT_MS` | `8000` | délai d'un appel |
| `MAILBOARD_JEV_CONCURRENCY` | `4` | appels simultanés |
| `MAILBOARD_JEV_CONFIG` | `config/jev.json` | autre jeu de questions |
| `MAILBOARD_JEV_ENDPOINT` | `jev.json` | autre URL System One (bouchon local, passerelle) |
| `MAILBOARD_CONFIG_DIR` | `config/` | déplacer tout le dossier de configuration |
| `MAILBOARD_CRITERIA` | `config/criteria.json` | autre fichier de critères |
| `MAILBOARD_PREFERENCES` | `config/preferences.json` | autre jeu de préférences |
| `MAILBOARD_CHANNELS` | `config/channels.local.json` | autre registre de canaux |
| `MAILBOARD_PROFILE` | `profile/profile.jev.md` | autre digest de profil |
| `MAILBOARD_PROFILE_SOURCE` | premier PDF de `profile/` | CV source à extraire |
| `MAILBOARD_PROFILE_MAX_CHARS` | `4000` | taille du digest envoyé |
| `MAILBOARD_WINDOW_HOURS` | `criteria.json` | fenêtre de collecte d'un run |

Le préfixe reste `MAILBOARD_` : c'est le nom du runtime (`window.MAILBOARD` dans
le dashboard). `jobmailboard` est le nom du dépôt.

## Précédence

Pour l'activation de JEV, le plus explicite gagne :

```text
--dry            coupe tout, sans condition, y compris avec --jev
--jev            active pour cette exécution
MAILBOARD_JEV    active ou coupe pour l'environnement
jev.json         valeur par défaut du dépôt
```

Une clé absente ramène le statut à `skipped:no-key` : jamais une erreur de run.
