# Collecte multicanal pour Mailboard

Ce document complète [JEV_INTEGRATION.md](JEV_INTEGRATION.md). Il ajoute une
deuxième question à l'architecture : comment Mailboard collecte-t-il des messages
quand la source n'expose pas de connecteur pratique, mais qu'une session ouverte
existe déjà dans Microsoft Edge ?

Le premier cas visé est Proton Mail, à l'adresse
`https://mail.proton.me/`, avec le compte `user-01@example.test` déjà
authentifié dans Edge.

## Décision

Mailboard adopte un modèle multicanal. Chaque compte ou source possède son propre
collecteur, mais tous écrivent le même format de run dans `data/runs-inbox/`.

Pour Proton Mail, le collecteur s'attache à la session Edge existante par CDP et
utilise [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast)
pour choisir les actions de navigation. Un extracteur Proton séparé lit ensuite
les champs utiles dans le DOM. La première version reste en lecture seule.

```text
sources concrètes
  ├─ Gmail / compte A
  ├─ Proton / user-01@example.test
  ├─ autre webmail / compte B
  └─ futur flux, fichier ou messagerie
                 │
                 ▼
        adaptateurs de collecte
  ┌──────────────┼────────────────────┐
  │ API          │ navigateur Edge    │ fichier / flux
  │ connecteur   │ JEV + extracteur   │ lecteur dédié
  └──────────────┴────────────────────┘
                 │ runs normalisés
                 ▼
        data/runs-inbox/
                 │
                 ▼
  déduplication par source + identifiant externe
                 │
                 ▼
       enrichissement JEV métier optionnel
                 │
                 ▼
     JSONL canonique + dashboard statique
```

Le navigateur ne remplace donc pas l'ingestion. Il devient une façon parmi
d'autres de produire un run.

## Vocabulaire

Trois axes évitent de confondre un compte, un fournisseur et son moyen d'accès.

| Axe | Exemples | Sens |
|---|---|---|
| `channelKind` | `mailbox`, `feed`, `messaging`, `file` | nature des données |
| `accessMode` | `connector`, `api`, `browser`, `drop` | moyen utilisé pour les lire |
| `provider` | `gmail`, `proton`, `outlook`, `rss` | système qui héberge la source |

Un **canal** correspond à une source concrète, par exemple la boîte Proton de
`user-01@example.test`. Deux comptes Proton représentent deux canaux, même
s'ils partagent le même `channelKind`, le même `accessMode` et le même
fournisseur.

Chaque canal reçoit un `sourceId` stable et sans information secrète :

```text
proton-Martin-Camille
gmail-primary
outlook-work
rss-france-travail
```

## Registre des canaux

Un futur fichier local `config/channels.local.json`, ignoré par Git, décrira les
sources activées. Le dépôt pourra fournir un `channels.example.json` sans adresse
personnelle ni chemin de profil réel.

Exemple local pour le cas Proton :

```json
{
  "channels": [
    {
      "sourceId": "proton-Martin-Camille",
      "enabled": true,
      "channelKind": "mailbox",
      "accessMode": "browser",
      "provider": "proton",
      "endpoint": "https://mail.proton.me/",
      "accountHint": "user-01@example.test",
      "browser": {
        "family": "edge",
        "attachMode": "cdp",
        "profile": "Default",
        "tabOwnership": "collector"
      },
      "collection": {
        "windowHours": 12,
        "folders": ["inbox"],
        "readMode": "list-only",
        "maxItems": 100
      }
    }
  ]
}
```

`accountHint` sert à vérifier que le bon compte est affiché. Il ne sert jamais à
se connecter. Aucun mot de passe, code 2FA, cookie ou jeton ne doit apparaître
dans ce fichier.

Une source par profil d'authentification reste la règle la plus sûre. Si un même
profil Edge contient plusieurs comptes Proton, la première version refuse de
basculer automatiquement entre eux. Elle s'arrête avec `wrong_account` quand le
compte visible ne correspond pas à `accountHint`.

## Pourquoi Edge compte ici

Le compte Proton est déjà authentifié dans Edge. Réutiliser cette session évite
de stocker un secret dans Mailboard et laisse la connexion, la 2FA et les alertes
de sécurité sous le contrôle du navigateur.

Edge parle le Chrome DevTools Protocol. Microsoft documente deux chemins pour
activer le débogage distant : lancer Edge avec un port CDP ou autoriser le
débogage depuis `edge://inspect`. Le second chemin convient mieux au profil déjà
ouvert : l'utilisateur donne l'autorisation une fois, puis le collecteur se
connecte au profil Edge concerné.

La première version applique ces règles :

- elle s'attache uniquement à un Edge déjà lancé ;
- elle sélectionne explicitement le profil prévu et vérifie qu'il s'agit d'Edge ;
- elle crée son propre onglet Proton en arrière-plan ;
- elle ne lit ni ne pilote les autres onglets ;
- à la fin, elle ferme seulement l'onglet qu'elle a créé, jamais Edge.

Le chemin du profil Edge ne doit pas être deviné à chaque run. Sous Windows, le
dossier stable se trouve en général sous
`%LOCALAPPDATA%\Microsoft\Edge\User Data`, mais `edge://version/` reste la source
locale à consulter pour le profil réellement utilisé.

## Écart avec `jev-ultrafast` aujourd'hui

Le dépôt amont est un MVP Python 3.12. Il dépend de `browser-harness` et de
`httpx`, puis connecte son exemple à Chrome. Sa classe `Browser` crée un onglet
CDP en arrière-plan, observe les contrôles visibles et exécute un petit ensemble
d'opérations : clic, saisie, sélection, défilement, attente, fin ou blocage.

Cette mécanique est compatible avec un navigateur Chromium, mais le dépôt ne
propose pas encore un paramètre public et explicite du type `browser="edge"`.
Mailboard ne doit pas supposer que l'exemple Chrome choisira Edge par hasard.

L'adaptation prévue est courte mais nécessaire :

```text
Edge déjà ouvert
      │ profil + DevToolsActivePort vérifiés
      ▼
adaptateur Edge/CDP
      │ session CDP explicite
      ▼
boucle jev-ultrafast
      │ page Proton atteinte
      ▼
extracteur DOM Proton
```

L'adaptateur doit échouer si le navigateur détecté, le profil ou le compte ne
correspond pas à la configuration. Il ne doit jamais se rabattre silencieusement
sur Chrome ou sur un profil Edge vierge.

Il faudra épingler `jev-ultrafast` à un commit testé au lieu de suivre `main` : le
projet est jeune, son contrat public peut encore bouger.

## Deux rôles JEV, deux traces

Mailboard utilisera potentiellement JEV à deux endroits, pour deux tâches sans
rapport direct.

### JEV de navigation

`jev-ultrafast` reçoit le but, l'URL courante, le texte visible et la table des
contrôles. Il choisit une opération et une cible. Cette boucle sert seulement à
atteindre la vue attendue dans Proton.

### JEV métier

Après normalisation et déduplication, l'intégration décrite dans
`JEV_INTEGRATION.md` évalue le message : demande de réponse, échéance, type
d'événement, niveau d'attention.

Ces appels conservent des métriques séparées : modèle, latence, tokens, statut,
identifiant de requête et coût. Une panne du JEV de navigation affecte un canal
browser ; une panne du JEV métier ne doit affecter aucun message collecté.

Le collecteur browser ne décide pas quels mails « méritent » d'être gardés. Il
applique une fenêtre, un dossier et une limite configurés. La pertinence vient
plus tard.

## Navigation et extraction ne sont pas la même tâche

`jev-ultrafast` sait agir sur une page et déclarer `DONE` ou `BLOCKED`. Il ne
renvoie pas une liste métier de messages prête à ingérer. Une couche Proton doit
donc extraire les données une fois la bonne vue visible.

Le partage des responsabilités reste net :

| Composant | Responsabilité |
|---|---|
| adaptateur Edge | trouver le profil, ouvrir et fermer l'onglet possédé, fournir CDP |
| `jev-ultrafast` | choisir les actions de navigation parmi les contrôles observés |
| adaptateur Proton | vérifier le compte et la vue, extraire les lignes de message |
| normaliseur | produire le contrat Mailboard sans dépendre du DOM Proton |
| ingesteur | valider, dédupliquer, archiver et reconstruire le dashboard |

Le DOM Proton changera. Les sélecteurs, noms accessibles et règles d'extraction
doivent rester dans `providers/proton.py`, pas dans l'ingesteur ni dans le
dashboard.

## Collecte Proton en lecture seule

La version initiale lit la liste de la boîte de réception sans ouvrir les
messages. Elle collecte ce que Proton affiche déjà dans chaque ligne :

- identifiant ou lien stable quand la page l'expose ;
- expéditeur affiché ;
- objet ;
- date ou heure ;
- extrait visible ;
- état non lu, quand il est exposé sans ambiguïté.

Ouvrir un mail peut le marquer comme lu et modifie alors le compte distant. Tant
que cet effet n'a pas été vérifié, `readMode: "list-only"` interdit l'ouverture.
La conséquence est assumée : le résumé sera l'extrait Proton, parfois court.

Les opérations suivantes restent interdites : composer, répondre, envoyer,
supprimer, archiver, déplacer, étiqueter, télécharger une pièce jointe, cliquer
un lien contenu dans un message ou changer l'état lu/non lu.

Si la session a expiré, si Proton demande un mot de passe, si la boîte est
verrouillée ou si une 2FA apparaît, le collecteur renvoie `needs_user`. Il ne
tente aucune saisie d'identifiant.

## Contrat de run version 2

Chaque collecteur écrit un fichier indépendant, y compris quand il ne trouve
aucun message. Un nom lisible suffit :

```text
data/runs-inbox/run-20260922-1900--proton-Martin-Camille.json
```

Le corps ajoute la provenance sans casser les champs actuels :

```json
{
  "schemaVersion": 2,
  "runAt": "2026-09-22T19:00:00.000Z",
  "windowHours": 12,
  "source": {
    "sourceId": "proton-Martin-Camille",
    "channelKind": "mailbox",
    "accessMode": "browser",
    "provider": "proton",
    "accountHint": "user-01@example.test"
  },
  "collector": {
    "name": "edge-mail-jev",
    "version": "0.1.0",
    "browser": "edge",
    "engine": "jev-ultrafast",
    "status": "ok"
  },
  "coverage": {
    "folder": "inbox",
    "from": "2026-09-22T07:00:00.000Z",
    "to": "2026-09-22T19:00:00.000Z",
    "complete": true,
    "itemsInspected": 24
  },
  "messages": [
    {
      "id": "provider-message-id",
      "identityQuality": "provider-id",
      "date": "2026-09-22T16:42:00.000Z",
      "from": "Recrutement Example",
      "subject": "Proposition d'entretien",
      "summary": "Deux créneaux sont proposés pour un entretien.",
      "link": "https://mail.proton.me/...",
      "category": "recruteurs"
    }
  ]
}
```

`collector.status` accepte `ok`, `partial`, `needs_user`, `wrong_account`,
`unavailable` et `error`. Un run en échec garde `messages: []` et explique la
couverture manquante avec un code court, sans copier le contenu de la page.

## Identité et déduplication

Un identifiant Gmail n'est unique que dans son univers. Avec plusieurs sources,
la clé canonique devient :

```text
messageKey = sourceId + ":" + id
```

`id` reste l'identifiant externe fourni par le canal. `messageKey` sert à la
déduplication et, à terme, au `localStorage` du dashboard. Pour les anciens
messages sans `sourceId`, l'ingesteur applique provisoirement
`gmail-legacy:<id>` afin de préserver leur état « traité ».

Le collecteur browser cherche l'identité dans cet ordre :

1. identifiant de message exposé par Proton dans le lien ou le DOM ;
2. identifiant de conversation stable, accompagné de la date du message ;
3. empreinte de repli sur `sourceId`, dossier, date normalisée, expéditeur et
   objet.

Un numéro d'élément DOM, sa position dans la liste ou son index JEV ne constitue
jamais un identifiant. Si seule l'empreinte de repli est disponible,
`identityQuality` vaut `fingerprint` et le dashboard peut signaler ce niveau de
confiance technique.

## Vie privée et contenu chiffré

Le fait d'utiliser Edge localement ne signifie pas que toutes les données
restent sur la machine. `jev-ultrafast` envoie à TypeSafe le texte visible et la
table des contrôles nécessaires à chaque décision. Quand l'opération
`TYPE_TEXT` intervient, un petit modèle de texte reçoit aussi le contexte prévu
par la bibliothèque ; l'exemple amont utilise OpenRouter.

Proton chiffre les messages avant leur affichage, mais Edge les déchiffre pour
l'utilisateur. Une fois le texte visible dans le DOM, l'envoyer à un modèle
externe sort ce texte du périmètre de chiffrement de Proton.

La configuration initiale réduit cette exposition :

- aucun screenshot, enregistrement vidéo ou trace DOM brute par défaut ;
- navigation limitée à `https://mail.proton.me/` ;
- collecte depuis la liste, sans ouvrir le corps ;
- `TYPE_TEXT` désactivé tant qu'une recherche n'est pas nécessaire ;
- journaux limités aux statuts, compteurs, durées et identifiants techniques ;
- activation explicite après lecture des conditions TypeSafe et du fournisseur
  du modèle de texte.

Si ces garanties ne conviennent pas, le bon choix n'est pas de cacher le risque
dans la documentation. Il faut remplacer la boucle JEV par une navigation locale
déterministe pour Proton, tout en gardant le même contrat de canal.

## Contenu hostile et frontières de navigation

Un objet ou un extrait d'e-mail peut contenir une instruction destinée à
détourner un agent. Le collecteur considère tout texte de mail comme une donnée,
jamais comme un ordre.

Les protections minimales sont codées, pas simplement écrites dans le prompt :

- liste de domaines autorisés limitée au webmail configuré ;
- refus de toute navigation vers un lien de message ;
- ensemble d'opérations réduit selon l'état courant ;
- aucune action d'écriture dans la boîte ;
- vérification du résultat par l'extracteur Proton avant `DONE` ;
- arrêt sur changement de compte, page de connexion ou dialogue inattendu.

La bibliothèque revalide déjà la fraîcheur et l'occlusion d'une cible avant un
clic. Mailboard ajoute les règles métier ci-dessus autour d'elle.

## Orchestration de plusieurs canaux

Chaque collecteur s'exécute séparément. Le planificateur lance les sources, puis
l'ingestion une fois les runs déposés. Le collecteur Proton ne lance pas
`ingest.mjs` lui-même ; cette séparation évite qu'un script chargé du navigateur
prenne aussi la responsabilité des données canoniques.

Deux collecteurs qui partagent le même profil Edge s'exécutent en série. Les
collecteurs API peuvent tourner en parallèle. Une erreur Proton n'empêche pas le
run Gmail d'aboutir, et chaque source conserve sa propre mesure de couverture.

Ordre proposé pour une fenêtre donnée :

```text
planificateur
  ├─ collecteur Gmail/API ─────────────► run Gmail
  ├─ collecteur Proton/Edge/JEV ───────► run Proton
  ├─ autres collecteurs ───────────────► autres runs
  └─ après collecte ───────────────────► node ingest/ingest.mjs
```

Le dashboard doit montrer la fraîcheur par source. Un « dernier run » global
masquerait facilement une boîte Proton en panne derrière un run Gmail réussi.

## Organisation de fichiers envisagée

```text
jobmailboard/
├── config/
│   ├── channels.example.json
│   └── channels.local.json        # ignoré par Git
├── collectors/
│   └── browser-mail/
│       ├── pyproject.toml          # Python 3.12, dépendances isolées
│       ├── collect.py              # produit un run, rien de plus
│       ├── edge.py                 # attachement CDP explicite
│       ├── jev_driver.py           # adaptation jev-ultrafast
│       └── providers/
│           └── proton.py           # vérification et extraction DOM
├── ingest/
│   ├── schema.md                   # futur contrat v2
│   └── ingest.mjs
└── data/
    └── runs-inbox/
```

Le collecteur Python reste optionnel. Un utilisateur qui ne configure que Gmail
conserve le fonctionnement Node actuel.

## Mise en place par paliers

> **État.** Paliers A, B et C implémentés dans `collectors/browser-mail/`.
> Deux modes de navigation coexistent : `--nav direct`, déterministe et gratuit,
> pour un chemin connu ; `--nav jev`, qui délègue les actions à `jev-ultrafast`
> pour ce qu'on ne sait pas décrire à l'avance. Les deux partagent l'extraction.
> Vérifié sur la boîte Proton : vue atteinte en 3 actions via JEV.

### Palier A : preuve d'attachement Edge

Le test ouvre un onglet possédé sur une page neutre, confirme le profil Edge et
le ferme sans toucher aux autres onglets. Aucun compte mail n'est lu.

### Palier B : Proton en observation

Le collecteur atteint la boîte, vérifie `user-01@example.test`, compte les
lignes visibles et écrit une trace sans sujet, expéditeur ni extrait. On valide
ainsi CDP, la session, les limites du DOM et la reprise sur erreur.

### Palier C : shadow collection

Les runs Proton contiennent les champs normalisés, mais le dashboard ne les
affiche pas encore. On compare les messages collectés à la boîte pendant quelques
runs et on mesure les doublons, absences et collisions d'identité.

### Palier D : affichage multicanal

L'ingesteur accepte `source`, calcule `messageKey` et expose la provenance. Le
dashboard ajoute un filtre par source et une fraîcheur par canal. Aucune action
distante n'est ajoutée.

L'enrichissement JEV métier vient ensuite, séparément, sur les nouveaux messages
normalisés.

## Conditions d'acceptation

- [ ] Le collecteur s'attache au profil Edge déjà authentifié et à aucun autre.
- [ ] Il ferme seulement son onglet.
- [ ] Une déconnexion Proton produit `needs_user`, sans tentative de login.
- [ ] Un mauvais compte produit `wrong_account` avant toute collecte.
- [ ] Le mode initial n'ouvre aucun message et ne change aucun état distant.
- [ ] Les domaines externes, pièces jointes et liens de mail restent inaccessibles.
- [ ] Aucun screenshot ou DOM brut n'est conservé par défaut.
- [ ] Un run vide documente quand même la couverture du canal.
- [ ] Deux sources portant le même `id` externe ne se dédupliquent pas entre elles.
- [ ] Une panne du canal Proton n'empêche ni Gmail ni l'ingestion locale.
- [ ] Le dashboard affiche la fraîcheur de chaque source, pas seulement la plus
  récente.
- [ ] L'usage de TypeSafe et du modèle de texte a reçu un accord explicite pour
  les données visibles de la boîte.

## Point de décision

Le premier travail n'est pas de généraliser tous les webmails. Il consiste à
prouver quatre choses sur Proton et Edge : attachement au bon profil, absence de
mutation, identité stable des messages et exposition de données jugée acceptable.

Si l'un de ces points échoue, le contrat multicanal reste valable. Seul le
collecteur Proton change.

## Sources

- [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast)
- [`browser-use/browser-harness`](https://github.com/browser-use/browser-harness)
- [Débogage distant de Microsoft Edge et connexion par CDP](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server)
- [SDK JavaScript/TypeScript officiel de TypeSafe](https://github.com/typesafe-ai/typesafe-sdk-js)

