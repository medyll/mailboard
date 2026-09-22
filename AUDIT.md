# Audit du projet mailboard

_Audit réalisé le 22/09/2026. Complète l'audit intégré à `ARCHITECTURE.md` (noté 7/10 : « socle validé, automatisation encore incomplète »), verdict confirmé._

## Vue d'ensemble

**mailboard** est un outil local de veille emploi : collecte de mails (Gmail + Proton via Edge/CDP), ingestion en JSONL, dashboard statique ouvrable en `file://`. Zéro dépendance npm, zéro serveur permanent, ~3 300 lignes de JS.

```
config/ (critères, canaux, préférences — tout déclaratif)
   → collecteurs (Gmail via tâche planifiée, Proton via Edge/CDP)
   → data/runs-inbox/ (runs v1/v2)
   → ingest/ingest.mjs (validation, dédup sourceId:id, JEV optionnel)
   → messages.jsonl + bodies.jsonl + projections dashboard/data.js
   → dashboard/index.html
```

## État actuel

- **Tests : 43/43 passent** (`node --test`) — adaptateur JEV, collecteur Proton (18 cas), éditeur de settings (transactions, rollback).
- **Données réelles** : 306 messages, 9 runs. Gmail 165, Proton 141. Mais **seulement 2 corps sur 306** — la recherche plein texte du dashboard est donc peu exploitée en pratique.
- Dépôt Git initialisé, données privées correctement ignorées.

## Points forts

- Architecture de pipeline de fichiers inspectable, séparation nette collecte / ingestion / projection.
- Documentation honnête et dense : 4 docs de conception, état réel vs. prévu distingué partout, leçons du terrain réinjectées (pièges du DOM Proton réel).
- Sécurité / vie privée codée plutôt que promptée : serveur settings en loopback avec jeton éphémère et écriture transactionnelle (rollback si le rebuild échoue), digest CV expurgé, secrets en variables d'env.
- Pilotage déclaratif : ajouter un critère ou un canal = éditer un JSON dans `config/`, jamais de code.
- Aucun `TODO`/`FIXME` dans le code — la dette est documentée dans les docs.

## Dette et risques

- **Pas d'orchestrateur** : le cycle complet (Gmail + Proton + ingestion + notification) repose sur une tâche planifiée externe et `AGENTS.md` comme contrat. Rien dans le dépôt ne lance le cycle.
- **Corps quasi absents** (2/306) : le canal Proton en `list-only` ne les fournit pas ; seul Gmail peut combler. La recherche plein texte et l'expansion des mails, arguments centraux du dashboard, restent peu exploités.
- **JEV dormant** : shadow mode implémenté et testé, mais 302 `skipped`, aucune décision réelle persistée. Critère d'arrêt explicite dans `JEV_INTEGRATION.md` : ne pas aller plus loin sans boucle de mesure.
- **Fragilité Edge/CDP** : profil dédié, flags (`--enable-automation`), port ouvert — maillon le plus cassant, sans preuve répétable à froid dans les conditions de la tâche planifiée.
- Pas de test DOM du dashboard.
- ~~Pas de CI, pas de test e2e d'ingestion~~ — corrigé : le test e2e v1/v2 existait déjà ; ajout d'un test de reprise (corps tardif, run rejoué, run illisible, `--dry`) et d'une CI Linux + Windows (`.github/workflows/test.yml`). 44/44.
- ~~`ARCHITECTURE.md` affirme « pas de dépôt Git initialisé »~~ — corrigé.

## Pistes d'évolution (par ordre d'impact)

1. **Formaliser l'orchestrateur** : ordre des canaux, états, reprise, notification depuis `mailboard.ingest.result` — c'est le chantier à plus fort impact.
2. **Couvrir les corps de mails** via le canal Gmail (Proton `list-only` ne peut pas les fournir).
3. Stabiliser le cycle Edge : port CDP reproductible dans les conditions de la tâche planifiée.
4. Test d'ingestion e2e avec fixtures v1/v2 et doublon inter-canaux.
5. Lancer le shadow mode JEV métier sur un petit lot réel, comparer au jugement humain avant toute phase 2.
6. Test navigateur minimal du dashboard (file://, filtres, expansion, localStorage).
7. À plus long terme : autres providers (Gmail browser, Outlook, RSS — le contrat v2 est prêt), phases JEV 2 (aide visuelle) et 3 (notification assistée) si la phase 1 mesure un gain.

## En résumé

Projet personnel remarquablement discipliné — design docs avant code, invariants tenus, sécurité codée — au stade **alpha fonctionnelle**. Le chantier qui rapporterait le plus n'est pas du nouveau code mais **l'automatisation du cycle complet** et **la couverture des corps de mails**.
