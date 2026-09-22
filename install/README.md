# Installation

Mailboard tourne sur un poste Windows avec l'app desktop Claude ouverte : la
tâche planifiée collecte Gmail par le connecteur, puis lance l'orchestrateur
qui collecte Proton dans Edge et ingère le tout.

## 1. Prérequis

- Node.js 22 ou plus récent (aucune dépendance npm).
- PowerShell 7 (`pwsh`) et Microsoft Edge, pour le canal Proton.
- L'app desktop Claude, avec le connecteur Gmail activé.

```bash
git clone https://github.com/medyll/mailboard.git
cd mailboard
node --test
```

## 2. Canaux

Copier `config/channels.example.json` en `config/channels.local.json` (ignoré
par Git), puis garder activés seulement les canaux utilisés. Pour la veille
standard :

- `gmail-primary` : `accessMode: "connector"`, collecté par la tâche planifiée ;
- `proton-perso` : `accessMode: "browser"`, collecté par l'orchestrateur.

Mettre l'adresse réelle dans `accountHint`. Aucun mot de passe ni jeton dans ce
fichier.

## 3. Profil Edge (canal Proton)

Premier lancement manuel, pour ouvrir le profil dédié et se connecter à Proton :

```bash
pwsh -File collectors/browser-mail/run.ps1 --check --keep-edge-open
```

Se connecter à Proton dans la fenêtre Edge ouverte, puis la fermer. Détails dans
[collectors/browser-mail/README.md](../collectors/browser-mail/README.md).

## 4. Tâche planifiée

Dans l'app desktop Claude, créer une tâche planifiée locale, dossier de travail
= ce dépôt :

- nom : « Veille emploi — mailboard » ;
- horaire : `0 6,15 * * *` (heure locale) ;
- prompt : le contenu de [veille-emploi.prompt.md](veille-emploi.prompt.md), en
  remplaçant `{{MAILBOARD_DIR}}` par le chemin absolu du dépôt.

Lancer un premier passage à la main (« Run now ») et accepter les autorisations
demandées (connecteur Gmail, `node`, `pwsh`). Vérifier ensuite que
`data/cycle-state.json` montre `ingest.status: "ok"`.

La tâche ne tourne que si l'app est ouverte ; un passage manqué est rattrapé au
lancement suivant, et les runs restés dans `data/runs-inbox/` sont repris par le
cycle d'après.

## 5. Dashboard

Ouvrir `dashboard/index.html` au double-clic.

## Mise à jour du prompt

Le prompt de référence est `install/veille-emploi.prompt.md`. Après l'avoir
modifié, recopier sa nouvelle version dans la tâche planifiée.
