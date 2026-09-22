# Profil

Sert de référence pour juger si une offre correspond au poste recherché :
langages, frameworks, séniorité, type de rôle. Sans ce fichier, les questions
d'adéquation (`stackMatch`, `roleFit`) sont retirées de l'appel JEV — le reste
de la veille fonctionne à l'identique.

**Tout ce dossier est ignoré par Git sauf ce README et `extract.mjs`.** Un CV
contient un nom, un téléphone, une adresse et un parcours : il n'a rien à faire
dans un dépôt.

## Mise en place

Déposer le CV en PDF ici, puis :

```bash
node profile/extract.mjs
```

Deux fichiers sont produits :

| Fichier | Contenu | Quitte la machine ? |
|---|---|---|
| `profile.cache.md` | texte intégral extrait du PDF | **non**, jamais |
| `profile.jev.md` | digest expurgé, tronqué | oui, c'est le seul envoyé au modèle |

L'extraction ne recommence que si le PDF a changé (empreinte dans l'en-tête du
cache). `--force` pour refaire le travail, `--show` pour lire le digest exact
qui partirait.

Un profil rédigé à la main dans `profile.md` est prioritaire sur le PDF. C'est la
solution la plus simple si `pdftotext` n'est pas installé, ou si le CV extrait
sort mal découpé.

## Ce qui est retiré du digest

Adresses e-mail, numéros de téléphone, URL, code postal et ville, adresses
postales. Les compétences, technologies, intitulés de poste et durées sont
conservés : ce sont eux qui répondent aux questions.

Pour retirer d'autres littéraux — nom, ancien employeur sous NDA — créer
`redact.local.txt`, un terme par ligne, casse ignorée :

```text
# une ligne par terme à retirer
PRENOM NOM
Ancien Employeur
```

Vérifier avant d'activer JEV :

```bash
node profile/extract.mjs --show
```

## Dépendance

`pdftotext` (poppler), fourni par Git for Windows, Homebrew et la plupart des
distributions. Le projet n'ajoute aucune dépendance npm pour cette conversion ;
à défaut de `pdftotext`, écrire `profile.md` à la main.
