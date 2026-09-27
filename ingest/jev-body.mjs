// Nettoyage du corps avant envoi à JEV (option `body.send`).
//
// Mesuré sur la vraie boîte (28/09/2026, 196 corps) : 21 % de l'extrait envoyé
// était du bruit (mentions légales, désabonnement, boutons d'application,
// « ne pas répondre »), et la moitié des corps étaient coupés à 1 500
// caractères — du contenu utile perdu pendant que le bruit partait. Certaines
// lignes de gabarit portaient aussi des données personnelles : prénom en
// salutation, bloc « profil » d'Indeed avec nom et salaire souhaité.
//
// Le corps stocké dans data/bodies.jsonl n'est jamais modifié : ce nettoyage
// ne s'applique qu'à ce qui quitte la machine.

import fs from 'node:fs';
import path from 'node:path';

// Début de pied de page : tout ce qui suit est du gabarit d'expéditeur. Ne
// coupe que dans la seconde moitié du mail, pour qu'un marqueur inattendu en
// tête ne fasse jamais perdre le contenu.
const PERSONAL_BLOCK = /^gardez votre profil/i;
const FOOTER_START = [
  /^vous n.êtes plus à la recherche/i,
  /^téléchargez notre application/i,
  /^conformément au règlement/i,
  /^vous avez reçu ce mail parce/i,
  /^cet e-?mail est destiné à/i,
  /^si vous ne souhaitez plus recevoir/i,
  /^indeed traite et analyse/i,
  /^vous recevez (ce|des) e-?mails?/i,
];

// Lignes à retirer où qu'elles soient : aucune n'aide à juger un mail emploi.
const DROP_LINE = [
  /(politique de confidentialité|privacy policy|conditions d.utilisation|^cgu$|^terms$|informatique et libertés|protection des données)/i,
  /(désabonn|désinscri|unsubscribe|ne plus recevoir|modifier vos préférences|gérer mes alertes|suspendre ces emails)/i,
  /(ne pas répondre|do not reply|ne sera pas transmis|ne sont pas traitées|please do not)/i,
  /(^©|copyright)/i,
  // Adresse légale d'expéditeur (« Hellowork SASU • 2 rue… », « … Limited, Block B,
  // Dublin 2 ») : forme sociale suivie d'une adresse. « X Pte Ltd vous propose une
  // offre » n'en a pas, et reste.
  /\b(SASU|SAS|SARL|Ltd|Limited|Inc)\b.*(•|\bBlock\b|Ireland|\b(rue|avenue|boulevard|quay)\b)/i,
  /^(voir l.offre|voir toutes les offres|voir l.emploi|ne correspond pas|espace candidat|aide et contact|centre d.aide|rechercher|connexion|en savoir plus|je finalise ma candidature|tout savoir sur l.entreprise|accéder à ma candidature|me désabonner|non|oui|introduction)$/i,
  /^(hello|bonjour|dear|salut)\b[^.!?\n]{0,30}[!,.]?$/i,
  /^(l.équipe \S+|à très vite dans vos recherches.*|à bientôt,?|bonne journée,?|cordialement,?)$/i,
  /^\S+\.(com|fr|org|io)$/i,
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Termes à masquer (nom, prénom…) : la liste locale d'expurgation du CV. */
export function loadRedactTerms(root) {
  const file = path.join(root, 'profile', 'redact.local.txt');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((t) => t.length >= 2 && !t.startsWith('#'));
}

/**
 * Corps prêt pour JEV : sans liens, sans pied de page, sans lignes de gabarit
 * ni doublons, identifiants personnels masqués. `maxChars` s'applique après le
 * nettoyage, pour que la place aille au contenu.
 */
export function cleanBody(text, { maxChars = 1500, terms = [] } = {}) {
  if (!text) return '';
  let lines = text
    .replace(/\r/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim());

  // Le bloc profil d'Indeed (nom, salaire souhaité) est coupé où qu'il soit :
  // il ne contient jamais rien d'autre que des données personnelles.
  const footer = lines.findIndex(
    (l, i) => i > 0 && (PERSONAL_BLOCK.test(l) || (i >= lines.length / 2 && FOOTER_START.some((re) => re.test(l)))),
  );
  if (footer > 0) lines = lines.slice(0, footer);

  const seen = new Set();
  lines = lines.filter((l) => {
    if (!l) return true;
    if (DROP_LINE.some((re) => re.test(l))) return false;
    // Les récapitulatifs répètent souvent la même offre : une fois suffit.
    const key = l.toLowerCase();
    if (l.length > 12 && seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let out = lines
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?){3,6}\d{2,4}/g, (m) =>
      m.replace(/\D/g, '').length >= 9 ? '[téléphone]' : m,
    );
  for (const term of terms) out = out.replace(new RegExp(escape(term), 'gi'), '[retiré]');
  return out.slice(0, maxChars);
}
