# Collecteur navigateur

Lit une boîte mail dans un navigateur **déjà authentifié**, et écrit un run dans
`data/runs-inbox/`. Rien d'autre. L'ingestion reste le seul endroit qui décide
de ce qui fait foi dans `data/` — c'est ce qui rend ce collecteur remplaçable.

Premier fournisseur : Proton (`providers/proton.mjs`). Le même squelette vaut
pour Gmail lu par navigateur : un canal `provider: "gmail"`, `accessMode:
"browser"`, et un `providers/gmail.mjs` à écrire.

```text
Edge déjà ouvert, session valide
        │  /json/version → « Edg/ » vérifié
        ▼
   edge.mjs           onglet créé, possédé, refermé
        │  Runtime.evaluate, origines sur liste blanche
        ▼
providers/proton.mjs  compte vérifié, lignes extraites
        │
        ▼
   collect.mjs        run v2 dans data/runs-inbox/
        │
        ▼
   node ingest/ingest.mjs
```

## Deux façons de naviguer

| Mode | Commande | Qui décide du chemin | Coût |
|---|---|---|---|
| **direct** (défaut) | `--nav direct` | le code : l'URL de la boîte est connue, le chemin est fixe | aucun appel |
| **jev** | `--nav jev` | `jev-ultrafast` : JEV reçoit un but et la table des éléments, et choisit l'opération et la cible | un appel TypeSafe par action |

Les deux **partagent l'extraction**. Une fois la vue atteinte, ce sont les mêmes
expressions de `providers/proton.mjs` qui lisent la page. Le modèle ne lit jamais
la liste à notre place : il ouvre la porte, le code entre.

Le mode direct reste le défaut parce qu'il ne coûte rien et ne fait sortir aucun
texte de la machine. Le mode JEV existe pour ce que le code ne sait pas décrire à
l'avance : un webmail inconnu, une vue derrière un parcours qui change, une
interface qui vient d'être refondue.

```bash
node collectors/browser-mail/collect.mjs --source proton-perso --nav jev --observe
```

Vérifié sur la vraie boîte : vue atteinte en 3 actions, compte confirmé, 50
lignes lues par les sondes du fournisseur.

### Ce que le pilote JEV refuse

`jev_driver.py` est un processus Python séparé, parce que `jev-ultrafast` est un
projet Python. Il porte ses propres gardes, codées et non confiées au prompt :

- il s'attache à un navigateur déjà lancé (`BU_CDP_URL`), n'en ouvre jamais un ;
- il vérifie l'origine de la page **après chaque action** et s'arrête à la
  première sortie de périmètre ;
- il refuse `TYPE_TEXT` : taper du texte demande un second modèle et personne ne
  doit écrire dans une boîte mail sans décision explicite ;
- il s'arrête au nombre d'actions configuré plutôt que de tourner en rond ;
- il attend que la liste soit hydratée avant de lire, sinon la vue « atteinte »
  rend des lignes sans date.

La dépendance est épinglée à un commit testé dans `pyproject.toml`, pas à `main` :
le projet est jeune et son contrat public peut bouger.

```bash
uv sync --project collectors/browser-mail
```

`TYPESAFE_API_KEY` est nécessaire — sans elle, le pilote renvoie `needs_user` et
le run reste vide plutôt que d'échouer. `TEXT_MODEL_API_KEY` ne sert qu'à
`TYPE_TEXT`, donc à rien ici.

La pagination, elle, reste déterministe dans les deux modes : tourner douze pages
à coups de décisions de modèle coûterait douze appels pour un geste qu'on sait
décrire en une ligne.

## Activer le débogage distant

Sous Windows, passer par le wrapper du collecteur :

```powershell
pwsh -File collectors/browser-mail/run.ps1 --check
pwsh -File collectors/browser-mail/run.ps1 --source proton-perso --observe
```

Le wrapper recharge `TYPESAFE_API_KEY` depuis l'environnement utilisateur si
le processus courant ne l'a pas reçue. Il lance une instance Edge dédiée sur le
port CDP configuré, attend qu'elle réponde, exécute le collecteur puis ferme
cette instance.

Au premier lancement, garder Edge ouvert pour se connecter une fois à Proton :

```powershell
pwsh -File collectors/browser-mail/run.ps1 --keep-edge-open --source proton-perso --observe
```

Les lancements suivants réutilisent la session conservée dans
`%LOCALAPPDATA%\Microsoft\Edge-mailboard`.

`collect.mjs` ne lance jamais Edge et n'ouvre jamais une session. Sans le
wrapper Windows, Edge doit donc déjà tourner avec un port CDP :

```bash
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --remote-debugging-port=9222
```

**Attendre un refus sur le profil par défaut.** Depuis Chromium 136, un
navigateur refuse `--remote-debugging-port` quand il utilise le répertoire de
données par défaut. Si `curl http://127.0.0.1:9222/json/version` ne répond pas,
c'est le cas. La parade est un répertoire dédié, où l'on se connecte à Proton
une fois pour toutes :

```bash
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="$LOCALAPPDATA/Microsoft/Edge-mailboard"
```

Le mot de passe, la 2FA et les alertes de sécurité restent gérés par le
navigateur. Mailboard ne stocke aucun secret et ne saisit jamais d'identifiant.

**Constaté sur Edge 154 :** un Edge déjà lancé absorbe le flag et l'ignore — le
port reste fermé. Il faut donc bien un répertoire de données distinct, qui donne
une seconde instance. Les fenêtres déjà ouvertes ne sont pas touchées.

La vérification du profil demande en plus `--enable-automation`, sans lequel
`Browser.getBrowserCommandLine` est refusé et le profil reste « non vérifiable ».
Le collecteur continue dans ce cas : la vérification du navigateur et celle du
compte affiché restent, elles, toujours actives.

Sans session dans ce profil, Proton renvoie vers `account.proton.me`. Le
collecteur s'arrête alors en `needs_user` : se connecter une fois dans cette
fenêtre suffit, il ne saisira jamais d'identifiant à votre place.

**Un port CDP ouvert pilote le navigateur.** N'importe quel programme local peut
s'y connecter et agir comme vous dans cette fenêtre. Ouvrir ce port le temps de
la collecte, fermer cette fenêtre Edge ensuite, et ne jamais l'exposer au réseau.

## Paliers

| Palier | Commande | Ce qui est prouvé |
|---|---|---|
| **A** | `node collectors/browser-mail/collect.mjs --check` | le bon navigateur, un onglet créé puis refermé, aucune boîte ouverte |
| **B** | `… --observe --source proton-perso` | boîte atteinte, compte vérifié, lignes comptées. Le run n'a **ni objet, ni expéditeur, ni extrait** |
| **C** | `… --source proton-perso` | lignes normalisées vers le contrat de run v2 |
| **D** | — | le dashboard affiche la provenance et la fraîcheur par canal |

`--dry` écrit le run nulle part et affiche ce qui serait produit.

Déclarer le canal dans `config/channels.local.json` (voir
`config/channels.example.json`). Le port se surcharge par `browser.port` ou par
`MAILBOARD_CDP_PORT`.

## Ce que le collecteur ne fait jamais

- lancer ou fermer le navigateur ;
- lire ou piloter un onglet qu'il n'a pas créé ;
- saisir un identifiant, un mot de passe ou un code 2FA ;
- ouvrir un message — cela le marquerait comme lu, donc modifierait le compte
  distant. `readMode: "list-only"` l'interdit, et le résumé est l'extrait
  affiché par Proton, parfois court ;
- composer, répondre, supprimer, archiver, étiqueter, télécharger une pièce
  jointe ou suivre un lien contenu dans un mail ;
- naviguer hors du webmail configuré — l'origine est vérifiée avant la
  navigation **et après**, car une page peut rediriger ;
- conserver une capture d'écran ou un DOM brut.

Un texte de mail est une donnée, jamais une instruction. Les protections
ci-dessus sont codées dans `edge.mjs`, pas confiées à un prompt.

## Statuts

`collector.status` dit pourquoi un run est vide, au lieu de laisser croire à une
boîte silencieuse :

| Statut | Quand |
|---|---|
| `ok` | collecte terminée dans la fenêtre demandée |
| `partial` | atteint, mais sélecteurs inconnus ou liste tronquée |
| `needs_user` | session expirée, verrouillée, 2FA, ou aucun Edge en débogage |
| `wrong_account` | navigateur, profil ou compte différent de la configuration |
| `unavailable` | CDP injoignable ou muet |
| `error` | tout le reste, y compris une navigation hors périmètre |

## Tests

```bash
node --test collectors/browser-mail/collect.test.mjs
```

Forme du run, fenêtre, identité, classement local, et les états de session
(SSO, page de connexion, mauvais compte, sélecteurs obsolètes) et l'analyse des
dates localisées : 18 cas, sans navigateur.

Les sélecteurs Proton se vérifient dans un vrai DOM. La page témoin exécute les
expressions exportées par `proton.mjs` — pas une copie — contre une liste
imitée :

```bash
npx --yes serve . -l 4180
```

puis ouvrir `http://127.0.0.1:4180/collectors/browser-mail/providers/proton.fixture.html`.
15 sondes doivent être vertes.

La page témoin prouve la logique d'extraction, pas que Proton expose encore ces
attributs. C'est le palier B qui tranche, et ce qu'il a trouvé sur la vraie
boîte le 22 septembre 2026 est désormais reflété ici :

| Relevé | Conséquence |
|---|---|
| la classe d'un mail non lu est `unread`, pas `item-is-unread` | tous les mails passaient pour lus |
| `<time datetime>` contient « mardi 22 septembre 2026 à 11:45 », pas de l'ISO | la fenêtre comparait des chaînes de texte et ne filtrait rien |
| les lignes sont rendues en squelette (`item-is-loading`) avant d'être remplies | lire trop tôt donnait des dates vides et un compte « illisible » |
| l'URL de la boîte dépend de la position du compte (`/u/1/`, pas `/u/0/`) | une session valide passait pour une déconnexion |
| la liste est virtualisée : 50 lignes rendues, pas toute la boîte | `coverage.complete` ne vaut que si une ligne plus ancienne que la fenêtre est visible |

`readyState: complete` ne suffit donc pas : `openInbox` attend que les lignes
soient hydratées, puis vérifie le compte, et seulement ensuite lit la liste.

Un détail volontaire de la page témoin : la troisième ligne n'a pas de
`data-element-id`. Comme la stratégie retient **le premier sélecteur qui
matche**, elle n'est pas collectée — les lignes restent homogènes plutôt que
mélangées. L'empreinte de repli sert quand Proton retire l'attribut partout, pas
ligne à ligne.
