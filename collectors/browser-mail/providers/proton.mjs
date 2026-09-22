// Connaissance du DOM Proton. Tout ce qui dépend de la forme de la page vit ici
// et nulle part ailleurs : ni l'ingesteur ni le dashboard n'ont à savoir à quoi
// ressemble une ligne de la boîte de réception.
//
// Les sélecteurs de Proton changent sans préavis. Chaque lecture est donc une
// liste de candidats, du plus stable (attributs de test) au plus fragile
// (classes CSS), et l'absence de résultat est un statut, jamais une supposition.

import { CollectorError } from '../errors.mjs';

export const ORIGIN = 'https://mail.proton.me';

// Racine, pas `/u/0/inbox` : l'index dans l'URL désigne la position du compte
// dans la session du navigateur, pas le compte lui-même. Le coder en dur envoie
// au sélecteur de comptes dès que la boîte visée n'est pas la première — c'est
// exactement ce qui a fait passer une session valide pour une déconnexion.
export const INBOX_URL = `${ORIGIN}/`;

// Sans session, Proton redirige vers son SSO. Ce n'est pas une sortie de
// périmètre — c'est la façon dont le fournisseur dit « connecte-toi ». L'origine
// reste sur liste blanche, mais y atterrir vaut `needs_user`, pas `error`.
export const AUTH_ORIGINS = ['https://account.proton.me'];

/**
 * Buts confiés à la navigation JEV. Ils décrivent une destination, jamais une
 * suite de clics : c'est tout l'intérêt de déléguer la navigation. Ils restent
 * en lecture seule — aucun but ne demande d'ouvrir, d'écrire ou de supprimer.
 */
export const NAV_GOALS = [
  "Afficher la liste des messages de la boîte de réception, sans ouvrir aucun message",
];

/**
 * Expressions évaluées dans l'onglet ; elles ne renvoient que des valeurs JSON.
 * Exportées pour que le test les exécute telles quelles contre une page témoin,
 * plutôt que d'en vérifier une copie qui dériverait en silence.
 */
export const PROBE = {
  // Page de connexion, de déverrouillage ou de 2FA : le collecteur s'arrête.
  needsUser: `(() => {
    const sel = ['input[name="username"]', 'input[name="password"]', '#password', '[data-testid="login:submit"]', 'form[name="unlockForm"]', '[data-testid="totp-input"]'];
    return sel.some((s) => document.querySelector(s)) || /\\/login|\\/unlock|\\/switch/.test(location.pathname);
  })()`,

  // Adresse du compte affiché. Les attributs de test sont tentés d'abord ; à
  // défaut, on cherche une adresse dans l'en-tête, sans ouvrir de menu.
  account: `(() => {
    const sel = [
      '[data-testid="userdropdown:label:display-name"]',
      '[data-testid="userdropdown:label:email"]',
      '[data-testid="heading:userdropdown"]',
      'header [title*="@"]',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      const text = (el?.getAttribute?.('title') || el?.textContent || '').trim();
      const hit = /[\\w.+-]+@[\\w-]+\\.[\\w.]+/.exec(text);
      if (hit) return hit[0].toLowerCase();
    }
    return null;
  })()`,

  // `readyState: complete` ne veut rien dire ici : Proton rend d'abord des
  // lignes squelettes, sans date ni état de lecture. Les lire à ce moment donne
  // des champs vides qu'on prendrait pour la vérité.
  listReady: `(() => {
    const rows = document.querySelectorAll('[data-element-id]');
    if (!rows.length) return false;
    return ![...rows].some((r) => r.classList.contains('item-is-loading'));
  })()`,

  rowCount: `(() => {
    const sel = ['[data-element-id]', '[data-testid^="message-item"]', '.item-container', '.item-container-wrapper'];
    for (const s of sel) {
      const n = document.querySelectorAll(s).length;
      if (n) return { selector: s, count: n };
    }
    return { selector: null, count: 0 };
  })()`,
};

/**
 * Lignes de la liste. `withContent: false` (palier B) ne renvoie que des
 * compteurs : on valide la session, les sélecteurs et la reprise sur erreur
 * avant qu'un seul objet de mail n'ait quitté la page.
 */
export const rowsExpression = (max, withContent) => `(() => {
  const sel = ['[data-element-id]', '[data-testid^="message-item"]', '.item-container', '.item-container-wrapper'];
  let nodes = [];
  let used = null;
  for (const s of sel) {
    nodes = [...document.querySelectorAll(s)];
    if (nodes.length) { used = s; break; }
  }
  const pick = (node, list) => {
    for (const s of list) {
      const el = node.querySelector(s);
      const text = (el?.getAttribute?.('title') || el?.textContent || '').trim();
      if (text) return text;
    }
    return null;
  };
  const rows = nodes.slice(0, ${max}).map((node) => {
    const id = node.getAttribute('data-element-id') || node.getAttribute('data-shortcut-target') || null;
    const time = node.querySelector('time');
    const base = {
      id,
      date: time?.getAttribute('datetime') || null,
      dateText: time ? time.textContent.trim() : null,
      unread: node.matches('.unread, .item-is-unread, [data-unread="true"]') || Boolean(node.querySelector('.item-unread-dot')),
    };
    ${
      withContent
        ? `return { ...base,
      from: pick(node, ['[data-testid="message-column:sender-address"]', '.item-senders', '.item-sender']),
      subject: pick(node, ['[data-testid="message-column:subject"]', '.item-subject', '.subject']),
      snippet: pick(node, ['.item-subject-preview', '.subject-preview', '.item-preview']),
    };`
        : `return base;`
    }
  });
  return { selector: used, total: nodes.length, rows };
})()`;

/** Vérifie la session et le compte affiché avant toute lecture de la liste. */
export async function openInbox(tab, { accountHint, settleTries = 24, settleMs = 500 }) {
  let landed = await tab.navigate(INBOX_URL);

  // Une session valide transite parfois par le SSO avant de revenir. Un vrai
  // écran de connexion, lui, ne bouge plus : on laisse le temps de trancher.
  const onAuth = (url) => AUTH_ORIGINS.some((o) => url.startsWith(o));
  for (let i = 0; onAuth(landed) && i < settleTries; i++) {
    await new Promise((r) => setTimeout(r, settleMs));
    landed = await tab.url();
  }
  if (onAuth(landed)) {
    throw new CollectorError('needs_user', 'Proton demande une connexion — aucune session dans ce profil');
  }

  if (await tab.eval(PROBE.needsUser)) {
    throw new CollectorError('needs_user', 'session Proton expirée, verrouillée ou en attente de 2FA');
  }

  // Ordre voulu : attendre que l'application soit rendue, vérifier le compte,
  // et seulement ensuite regarder les lignes. Interroger l'en-tête trop tôt
  // renvoie « compte illisible » sur une session pourtant valide, et arrêterait
  // une collecte légitime en `wrong_account`.
  let ready = false;
  let account = null;
  for (let i = 0; i < settleTries; i++) {
    ready = await tab.eval(PROBE.listReady);
    account = await tab.eval(PROBE.account);
    if (ready && account) break;
    await new Promise((r) => setTimeout(r, settleMs));
  }

  if (accountHint) {
    if (!account) {
      // Mieux vaut ne rien collecter que collecter la mauvaise boîte.
      throw new CollectorError('wrong_account', 'compte affiché illisible, vérification impossible');
    }
    if (account !== accountHint.toLowerCase()) {
      throw new CollectorError('wrong_account', `compte affiché ${account}, attendu ${accountHint}`);
    }
  }

  const { selector, count } = await tab.eval(PROBE.rowCount);
  if (!selector) {
    throw new CollectorError('partial', 'aucune ligne reconnue — les sélecteurs Proton ont probablement changé');
  }
  if (!ready) {
    throw new CollectorError('partial', `liste encore en chargement après ${(settleTries * settleMs) / 1000} s`);
  }
  return { account, selector, visibleRows: count };
}

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

/**
 * `<time datetime>` de Proton ne contient pas d'ISO 8601 mais la date localisée
 * — « mardi 22 septembre 2026 à 11:45 » en français. Constaté sur la vraie
 * boîte : sans conversion, la fenêtre de collecte compare des chaînes de texte
 * et ne filtre plus rien.
 *
 * Les composants sont interprétés dans le fuseau local, celui du navigateur qui
 * a rendu la page comme celui du collecteur : c'est la même machine.
 */
export function parseProtonDate(raw) {
  if (!raw) return null;

  // Cas d'une vraie valeur ISO, si Proton y revient un jour.
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const iso = new Date(raw);
    return Number.isNaN(+iso) ? null : iso.toISOString();
  }

  const fr = /(\d{1,2})\s+([a-zà-ÿ]+)\s+(\d{4})(?:\D+(\d{1,2})[:h](\d{2}))?/i.exec(raw);
  if (fr) {
    const mois = MOIS_FR.indexOf(fr[2].toLowerCase());
    if (mois > -1) {
      const d = new Date(Number(fr[3]), mois, Number(fr[1]), Number(fr[4] ?? 0), Number(fr[5] ?? 0));
      return Number.isNaN(+d) ? null : d.toISOString();
    }
  }

  const numerique = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\D+(\d{1,2})[:h](\d{2}))?/.exec(raw);
  if (numerique) {
    const d = new Date(
      Number(numerique[3]), Number(numerique[2]) - 1, Number(numerique[1]),
      Number(numerique[4] ?? 0), Number(numerique[5] ?? 0),
    );
    return Number.isNaN(+d) ? null : d.toISOString();
  }

  // Une date illisible reste nulle : mieux vaut une date absente qu'une date
  // inventée, qui fausserait la fenêtre et l'ordre d'affichage.
  return null;
}

// Proton ne charge pas la suite au défilement : la boîte est paginée, 50 lignes
// par page, avec un indicateur « 3/12 » dans la barre d'outils. Remonter un mois
// veut donc dire tourner les pages, pas faire défiler.
const PAGER = `(() => {
  const suivant = document.querySelector('[data-testid="toolbar:next-page"]');
  const indicateur = document.querySelector('[data-testid="toolbar:page-number-dropdown"]');
  return {
    page: (indicateur?.textContent || '').trim() || null,
    peutAvancer: Boolean(suivant) && !suivant.disabled && suivant.getAttribute('aria-disabled') !== 'true',
  };
})()`;

// Clic sur un contrôle de pagination désigné par son attribut de test : jamais
// sur une ligne, jamais sur un lien contenu dans un mail.
const PAGE_SUIVANTE = `(() => {
  const b = document.querySelector('[data-testid="toolbar:next-page"]');
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`;

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// Identifiant de la première ligne : le seul signal fiable qu'une page a
// vraiment été remplacée. Le libellé « 3/12 » de la barre d'outils, lui, change
// dès le clic, avant que les lignes n'arrivent.
const PREMIERE_LIGNE = `document.querySelector('[data-element-id]')?.getAttribute('data-element-id') ?? null`;

/** « 3/12 » → { index: 3, total: 12 }. Dit quand il est inutile d'attendre. */
const lirePagination = (label) => {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(label ?? '');
  return m ? { index: Number(m[1]), total: Number(m[2]) } : { index: null, total: null };
};

/**
 * Lecture de la liste. N'ouvre aucun message : `readMode: list-only`.
 *
 * `until` (ISO) demande de remonter jusqu'à cette date : la lecture tourne les
 * pages jusqu'à voir une ligne plus ancienne, ce qui prouve d'avoir atteint le
 * bord de la fenêtre. Sans `until`, seule la première page est lue.
 */
export async function readList(
  tab,
  { maxItems = 100, withContent = false, until = null, maxPages = 12, settleTries = 20, settleMs = 500, onPage } = {},
) {
  const collectees = new Map();
  let selector = null;
  let atteintLeBord = false;
  let pagesLues = 0;

  const lireUnePage = async () => {
    const vue = await tab.eval(rowsExpression(maxItems, withContent));
    if (!vue.selector) return 0;
    selector = vue.selector;
    let ajoutees = 0;
    for (const brute of vue.rows) {
      const ligne = { ...brute, date: parseProtonDate(brute.date ?? brute.dateText), rawDate: brute.date ?? null };
      // Une ligne sans identifiant n'a pas de clé fiable pour l'accumulation :
      // on la garde sous une clé dérivée, l'empreinte tranchera plus tard.
      const cle = ligne.id ?? `${ligne.rawDate}|${ligne.subject ?? ''}`;
      if (!collectees.has(cle)) {
        collectees.set(cle, ligne);
        ajoutees++;
      }
      if (until && ligne.date && ligne.date < until) atteintLeBord = true;
    }
    return ajoutees;
  };

  /** Attend que les lignes elles-mêmes aient changé et soient hydratées. */
  const attendrePage = async (premiereAvant) => {
    for (let i = 0; i < settleTries; i++) {
      await attendre(settleMs);
      const premiere = await tab.eval(PREMIERE_LIGNE);
      if (premiere && premiere !== premiereAvant && (await tab.eval(PROBE.listReady))) {
        return await tab.eval(PAGER);
      }
    }
    return null;
  };

  /**
   * La barre d'outils reste désactivée un instant après le rendu des lignes.
   * Lire son état une seule fois ferait conclure « une seule page » sur une
   * boîte qui en compte douze.
   */
  const attendrePager = async () => {
    let dernier = { page: null, peutAvancer: false };
    for (let i = 0; i < settleTries; i++) {
      dernier = await tab.eval(PAGER);
      const { index, total } = lirePagination(dernier.page);
      if (dernier.peutAvancer || (index && total && index >= total)) return dernier;
      await attendre(settleMs);
    }
    return dernier;
  };

  if (!(await lireUnePage())) throw new CollectorError('partial', 'liste vide ou sélecteurs obsolètes');
  pagesLues = 1;
  let etat = await attendrePager();
  onPage?.({ page: etat.page, collectees: collectees.size });

  while (until && !atteintLeBord && collectees.size < maxItems && pagesLues < maxPages && etat.peutAvancer) {
    const premiereAvant = await tab.eval(PREMIERE_LIGNE);
    if (!(await tab.eval(PAGE_SUIVANTE))) break;

    const arrivee = await attendrePage(premiereAvant);
    if (!arrivee) {
      // La page n'a pas tourné dans le temps imparti : on s'arrête sur ce qu'on
      // a, et la couverture dira qu'elle est incomplète.
      break;
    }
    pagesLues++;
    const ajoutees = await lireUnePage();
    etat = await attendrePager();
    onPage?.({ page: arrivee.page, collectees: collectees.size, ajoutees });
    // Une page qui n'apporte rien signale une boucle : mieux vaut s'arrêter que
    // tourner douze pages pour rien.
    if (!ajoutees) break;
  }

  return {
    selector,
    inspected: collectees.size,
    pages: pagesLues,
    lastPage: etat.page,
    reachedEdge: atteintLeBord,
    rows: [...collectees.values()],
  };
}

/**
 * Identité d'une ligne, par ordre de préférence :
 *   1. identifiant exposé par Proton ;
 *   2. empreinte sur canal + dossier + date + expéditeur + objet.
 * Une position dans la liste n'est jamais une identité.
 */
export function identify(row, { sourceId, folder }, hash) {
  if (row.id) return { id: row.id, identityQuality: 'provider-id' };
  const seed = [sourceId, folder, row.date ?? row.dateText ?? '', row.from ?? '', row.subject ?? ''].join('|');
  return { id: `fp-${hash(seed)}`, identityQuality: 'fingerprint' };
}
