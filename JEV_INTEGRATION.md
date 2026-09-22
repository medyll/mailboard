# Intégration de JEV dans Mailboard

> Hypothèse de travail : « JEV » désigne **Jev de TypeSafe**, le modèle System One
> qui reçoit un état et des questions typées, puis renvoie des décisions bornées
> (`noul`, `choice`, `score`) avec leurs probabilités. Si un autre JEV était visé,
> cette hypothèse est le seul point à remplacer avant mise en œuvre.

La collecte depuis plusieurs comptes et l'usage de `jev-ultrafast` avec une
session Microsoft Edge existante sont décrits dans
[COLLECTE_MULTICANAL.md](COLLECTE_MULTICANAL.md).

## Décision proposée

Intégrer JEV comme **enrichissement optionnel des nouveaux messages**, après la
déduplication Gmail et avant leur écriture dans `data/messages.jsonl`.

JEV ne devient ni une source de vérité, ni un générateur de résumé, ni une
dépendance du dashboard. Mailboard continue de fonctionner localement quand JEV
est absent, lent ou indisponible.

```text
recherches Gmail
      │
      ▼
run JSON dans data/runs-inbox/
      │
      ▼
validation + déduplication locale par id Gmail
      │
      ├── doublon ───────────────────────► mise à jour lastSeenAt / seenCount
      │
      └── nouveau message
              │
              ▼
        enrichissement JEV optionnel
        (plusieurs questions, un appel)
              │
              ├── succès ────────────────► champs `jev.*`
              └── erreur / pas de clé ───► `jev.status`, sans bloquer
                                              │
                                              ▼
                                  messages.jsonl + runs.jsonl
                                              │
                                              ▼
                                      dashboard/data.js
```

Cette position dans la chaîne préserve les invariants actuels :

- l'`id` Gmail reste l'unique clé de déduplication ;
- un run vide reste une preuve de couverture ;
- chaque message trouvé reste visible, quel que soit le résultat de JEV ;
- `dashboard/data.js` reste généré par `ingest/ingest.mjs` ;
- l'état « traité » reste local au navigateur ;
- `--dry` n'écrit rien **et ne déclenche aucun appel payant**.

## Pourquoi JEV peut être utile ici

Mailboard n'a pas besoin d'un autre modèle pour écrire du texte : le run possède
déjà `subject`, `summary` et `category`. Il peut en revanche tirer parti de
petites décisions répétitives et bornées :

1. le message demande-t-il explicitement une réponse ?
2. contient-il une échéance ou une pression temporelle ?
3. quel événement de recherche d'emploi décrit-il ?
4. à quel niveau d'attention appartient-il ?

JEV convient à ces jugements rapides. La politique finale — ordre d'affichage,
notification, revue manuelle — doit rester du code déterministe dans Mailboard.

### Ce que JEV ne doit pas faire

- rédiger ou réécrire `summary` ;
- décider si un message doit être conservé pendant la première phase ;
- remplacer les trois requêtes Gmail ou leur fenêtre temporelle ;
- comparer des dates, compter les occurrences ou dédupliquer ;
- marquer automatiquement un message comme « traité » ;
- recevoir l'identifiant Gmail, le lien Gmail ou le contenu complet d'une boîte.

## Premier jeu de questions

Toutes les questions portant sur un message partent dans **un seul appel**. Elles
restent atomiques ; les seuils et combinaisons restent dans le code.

| Identifiant | Primitive | Question | Usage envisagé |
|---|---|---|---|
| `needsReply` | `noul` | Le message demande-t-il explicitement une réponse ou une action du destinataire ? | badge et priorité |
| `hasDeadline` | `noul` | Le message mentionne-t-il une échéance ou une action limitée dans le temps ? | hausse de priorité |
| `eventKind` | `choice` | Quel événement principal le message décrit-il ? | regroupement visuel |
| `attention` | `score` | Quel niveau d'attention opérationnelle exige-t-il ? | tri, jamais suppression |

Options initiales de `eventKind` :

- `acknowledgement` : accusé de réception ou confirmation automatique ;
- `request` : demande d'information, de document ou d'action ;
- `invitation` : entretien, appel ou rendez-vous proposé ;
- `decision_positive` : suite favorable ou progression ;
- `decision_negative` : refus ou clôture défavorable ;
- `administrative` : actualisation, justificatif, démarche ou rappel administratif ;
- `information` : information utile ne demandant pas d'action explicite ;
- `other` : aucun cas précédent ne convient clairement.

Niveaux ordonnés de `attention` :

1. « information sans action attendue » ;
2. « action utile mais différable » ;
3. « action à effectuer prochainement » ;
4. « action explicite ou échéance proche ».

Ces libellés sont un point de départ, pas un contrat définitif. Ils doivent être
testés sur des exemples labellisés avant de piloter une notification.

## État minimal envoyé au fournisseur

Envoyer uniquement ce dont les questions ont besoin :

```json
{
  "message": {
    "currentCategory": "recruteurs",
    "senderDomain": "example.org",
    "subject": "Proposition d'entretien",
    "summary": "Le recruteur propose deux créneaux et demande une confirmation."
  }
}
```

Ne pas envoyer : `id`, `threadId`, `link`, `runId`, `firstSeenAt`, `lastSeenAt`
ou `seenCount`. Les dates et compteurs sont traités localement. Lorsque l'adresse
de l'expéditeur est utile, ne conserver que son domaine ; omettre le local-part.

Même réduit, cet état contient des données issues d'e-mails. L'activation doit
donc être explicite et précédée d'une vérification des conditions de traitement,
de conservation et de localisation du fournisseur.

## Contrat de données additif

Les champs existants ne changent pas. Un message peut recevoir un objet `jev`
versionné :

```json
{
  "jev": {
    "status": "ok",
    "schemaVersion": 1,
    "questionSet": "mailboard-v1",
    "model": "jev-1.13.0",
    "evaluatedAt": "2026-09-22T19:05:00.000Z",
    "inputFingerprint": "sha256:…",
    "requestId": "req_…",
    "answers": {
      "needsReply": { "probability": 0.94 },
      "hasDeadline": { "probability": 0.81 },
      "eventKind": {
        "value": "invitation",
        "confidence": 0.91,
        "probabilities": { "invitation": 0.91, "request": 0.07, "other": 0.02 }
      },
      "attention": {
        "value": 2.72,
        "confidence": 0.76,
        "probabilities": { "0": 0.01, "1": 0.08, "2": 0.24, "3": 0.67 }
      }
    }
  }
}
```

`status` accepte au minimum :

- `ok` : réponse reçue et validée ;
- `skipped` : intégration désactivée ou clé absente ;
- `error` : appel ou validation échoué ; le message est tout de même ingéré.

Pour `error`, ne persister qu'un code stable (`timeout`, `rate_limited`,
`unauthorized`, `invalid_response`, `unavailable`) et jamais une clé, un en-tête
d'autorisation ou une réponse contenant des données sensibles.

Le `inputFingerprint` permet de savoir si une décision correspond encore aux
champs envoyés. Il ne sert pas d'identifiant métier. `questionSet` rend les
résultats comparables et empêche de confondre deux formulations différentes.

En expérimentation, `jev-latest` est acceptable. Dès qu'un seuil pilote le
comportement, épingler une version de modèle, puis réévaluer explicitement lors
d'un changement de version.

## Politique locale dérivée

Le modèle fournit des observations ; Mailboard calcule la priorité. Exemple à
calibrer, volontairement non activé au départ :

```text
revue manuelle si :
  confiance eventKind < seuil_event
  OU réponse proche de son seuil de décision

priorité haute si :
  eventKind = invitation
  OU needsReply >= seuil_reply
  OU hasDeadline >= seuil_deadline

priorité normale sinon
```

Les seuils ne doivent pas être devinés dans le code initial. Ils sont choisis à
partir d'exemples labellisés, avec une attention particulière aux faux négatifs
sur les invitations, échéances et demandes de réponse.

## Forme technique recommandée

Mailboard n'a aujourd'hui ni `package.json`, ni build, ni dépendance. La première
implémentation devrait préserver cette propriété :

- un petit adaptateur `ingest/jev.mjs` utilisant `fetch` natif de Node ;
- les questions et leur version dans `ingest/jev-questions.mjs` ;
- le secret uniquement dans `TYPESAFE_API_KEY` ;
- un timeout court et une concurrence bornée, par exemple quatre messages ;
- un appel par nouveau message, contenant toutes les questions ;
- aucun appel pour les doublons ni en mode `--dry` ;
- une option explicite `--jev` pendant l'expérimentation ;
- une commande séparée de réévaluation avant tout éventuel backfill
  (implémentée : `ingest/jev-backfill.mjs`, voir le README).

L'API HTTP documentée est `POST https://api.typesafe.ai/v1/systemone`. Le corps
porte `model`, `state` et `questions`, avec un en-tête `Authorization: Bearer …`.
L'adaptateur doit rester le seul endroit connaissant ce protocole.

Le SDK officiel `@typesafe-ai/sdk` est une alternative valable si le projet
accepte plus tard une dépendance et un `package.json`. Il apporte notamment les
constructeurs typés côté TypeScript, mais n'est pas nécessaire pour valider le
premier usage de Mailboard.

## Ordre d'exécution et reprise sur erreur

L'enrichissement doit se produire après identification des nouveaux `id`, mais
avant les écritures et déplacements de fichiers. Une panne JEV se transforme en
résultat `error` ou `skipped`, jamais en abandon du run.

Pour chaque nouveau message :

1. construire l'état minimal ;
2. calculer son empreinte ;
3. appeler JEV si `--jev` et `TYPESAFE_API_KEY` sont présents ;
4. valider strictement le type et les options de chaque réponse ;
5. attacher le bloc `jev` ou un statut de repli ;
6. poursuivre l'ingestion normale.

Les réponses non conformes sont des erreurs. Il ne faut pas convertir une valeur
inconnue vers `other` silencieusement : cela masquerait une rupture de contrat.

Les retries automatiques sont à limiter. Un timeout peut avoir eu lieu après
traitement côté fournisseur et un nouvel essai peut donc être facturé à nouveau.
Pour cette application non critique, un essai par run, puis reprise au run ou à
la réévaluation suivante, est une politique simple et observable.

## Déploiement progressif

### Phase 0 — documenter, sans modifier le runtime

Le présent fichier fixe le rôle de JEV et ses frontières. Aucun comportement
existant ne change.

### Phase 1 — shadow mode

**Implémentée.** `ingest/jev.mjs` (adaptateur), `config/jev.json` (questions et
seuils), `ingest/jev.test.mjs` (14 cas contre un faux serveur), métriques dans
`data/jev-runs.jsonl`. Les décisions sont persistées ; rien ne les affiche.

- appeler JEV uniquement avec `--jev` ;
- persister les décisions, sans les afficher ni les utiliser ;
- conserver tous les messages ;
- relever latence, erreurs, tokens, modèle et identifiant de requête ;
- labelliser un petit corpus réel et synthétique.

Sortie de phase : les réponses sont stables sur les cas importants, les données
envoyées sont acceptées du point de vue confidentialité, et une panne complète du
fournisseur n'altère pas le résultat de l'ingestion.

### Phase 2 — aide visuelle

- afficher `eventKind` et une priorité calculée localement ;
- ajouter une vue « à vérifier » pour les décisions incertaines ;
- ne jamais masquer un message sur la seule base de JEV ;
- permettre de comparer la décision au jugement humain.

### Phase 3 — notification assistée

- utiliser JEV pour augmenter une notification, pas pour supprimer silencieusement
  un message ;
- conserver une voie de revue pour les cas proches des seuils ;
- versionner questions, modèle et seuils ensemble.

Une automatisation destructive ou irréversible n'est pas justifiée pour ce
projet. Si le besoin apparaît, elle exige une évaluation dédiée.

## Vérifications avant activation

- [ ] Sans clé, l'ingestion et le dashboard restent identiques.
- [ ] `--dry --jev` ne fait aucun appel réseau et aucune écriture.
- [ ] Un doublon Gmail ne déclenche aucun nouvel appel.
- [ ] Une erreur 401, 429, 5xx, un timeout ou un JSON invalide n'arrête pas le run.
- [ ] Les secrets sont absents des fichiers, logs et messages d'erreur.
- [ ] Aucun identifiant ni lien Gmail n'est envoyé au fournisseur.
- [ ] Chaque réponse est validée contre le jeu de questions attendu.
- [ ] `questionSet`, modèle et empreinte sont persistés avec la décision.
- [ ] Le dashboard accepte les anciens messages dépourvus de champ `jev`.
- [ ] Les seuils proviennent d'un corpus labellisé, pas d'une intuition isolée.
- [ ] Le coût et la latence sont mesurés sur un run réel avant activation continue.

## Critère d'arrêt

Ne pas intégrer JEV au-delà du shadow mode si les décisions n'améliorent pas une
action concrète du dashboard : retrouver plus vite les messages à traiter,
réduire les notifications inutiles sans rater les importantes, ou rendre les cas
incertains visibles. Ajouter un modèle sans boucle de mesure ne ferait qu'ajouter
du réseau, du coût et une nouvelle surface de panne.

## Sources techniques

- [Présentation officielle de JEV et des System One Models](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [SDK JavaScript/TypeScript officiel](https://github.com/typesafe-ai/typesafe-sdk-js)
- [Guides officiels pour construire avec JEV](https://github.com/typesafe-ai/skills)
- [Documentation TypeSafe](https://docs.typesafe.ai/)
