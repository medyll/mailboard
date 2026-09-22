// Attachement CDP à un Microsoft Edge **déjà lancé**.
//
// Ce module ne sait rien des mails. Il sait ouvrir un onglet qui lui appartient,
// y naviguer dans les limites d'une liste de domaines autorisés, évaluer du
// JavaScript dans ce seul onglet, et le refermer. Il ne lance jamais Edge, ne
// ferme jamais Edge, et ne touche à aucun onglet qu'il n'a pas créé.
//
// Zéro dépendance : Node ≥ 22 fournit un client WebSocket natif, et le Chrome
// DevTools Protocol tient sur cette seule brique.

import { setTimeout as delay } from 'node:timers/promises';
import { CollectorError } from './errors.mjs';

export { CollectorError };

async function httpJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new CollectorError('unavailable', `${url} → HTTP ${res.status}`);
  return res.json();
}

/** Connexion CDP : une socket, des commandes numérotées, des sessions plates. */
class Cdp {
  constructor(ws, timeoutMs) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const waiter = this.pending.get(msg.id);
      if (!waiter) return; // évènement non sollicité : on ne s'y abonne pas
      this.pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(`${msg.error.message} (${msg.method ?? ''})`)) : waiter.resolve(msg.result);
    });
  }

  static async connect(url, timeoutMs) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new CollectorError('unavailable', 'socket CDP refusée')), { once: true });
    });
    return new Cdp(ws, timeoutMs);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      AbortSignal.timeout(this.timeoutMs).addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        reject(new CollectorError('unavailable', `CDP ${method} sans réponse`));
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* socket déjà tombée : rien à sauver */
    }
  }
}

const origin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Onglet possédé par le collecteur. Toute navigation est vérifiée contre la
 * liste d'origines autorisées — avant l'appel, et de nouveau après, car une
 * page peut rediriger.
 */
class OwnedTab {
  constructor(cdp, targetId, sessionId, allowedOrigins) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.allowed = allowedOrigins;
  }

  async navigate(url) {
    if (!this.allowed.includes(origin(url))) {
      throw new CollectorError('error', `navigation hors périmètre : ${origin(url)}`);
    }
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await this.settle();
    const landed = await this.url();
    if (!this.allowed.includes(origin(landed))) {
      throw new CollectorError('error', `redirection hors périmètre : ${origin(landed)}`);
    }
    return landed;
  }

  /** Attente du repos réseau, à défaut d'un évènement : on ne s'abonne à rien. */
  async settle({ tries = 20, everyMs = 250 } = {}) {
    for (let i = 0; i < tries; i++) {
      await delay(everyMs);
      const ready = await this.eval('document.readyState');
      if (ready === 'complete') return;
    }
  }

  /**
   * Évalue une expression dans l'onglet possédé. Le retour passe par JSON :
   * aucun nœud DOM, aucune capture, aucun handle ne remonte côté Node.
   */
  async eval(expression) {
    const res = await this.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    );
    if (res.exceptionDetails) {
      throw new CollectorError('error', `évaluation échouée : ${res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  url() {
    return this.eval('location.href');
  }

  async close() {
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId });
  }
}

/**
 * S'attache à l'Edge en écoute sur `port`, vérifie que c'en est bien un, ouvre
 * un onglet neutre en arrière-plan et le confie à `work`. L'onglet est refermé
 * quoi qu'il arrive ; le navigateur, jamais.
 */
export async function withOwnedTab({ port = 9222, family = 'edge', profile = null, allowedOrigins = [], timeoutMs = 15000 }, work) {
  let version;
  try {
    version = await httpJson(`http://127.0.0.1:${port}/json/version`, 3000);
  } catch {
    throw new CollectorError(
      'needs_user',
      `aucun navigateur en débogage distant sur 127.0.0.1:${port} — voir collectors/browser-mail/README.md`,
    );
  }

  // « Edg/ » distingue Edge de Chrome ; les deux parlent le même protocole, et
  // se tromper de navigateur signifierait se tromper de session ouverte.
  const product = version.Browser ?? '';
  if (family === 'edge' && !/Edg\//.test(product)) {
    throw new CollectorError('wrong_account', `navigateur inattendu sur le port ${port} : ${product}`);
  }

  const cdp = await Cdp.connect(version.webSocketDebuggerUrl, timeoutMs);
  let tab = null;
  try {
    // Le profil n'est pas toujours exposé ; quand il l'est, une contradiction
    // avec la configuration arrête tout plutôt que de lire la mauvaise boîte.
    let commandLine = null;
    try {
      const res = await cdp.send('Browser.getBrowserCommandLine');
      commandLine = (res.arguments ?? []).join(' ');
    } catch {
      /* commande indisponible sur cette version : profil non vérifiable */
    }
    if (profile && commandLine) {
      const declared = /--profile-directory=("?)([^"\s]+)\1/.exec(commandLine)?.[2];
      if (declared && declared !== profile) {
        throw new CollectorError('wrong_account', `profil Edge ${declared}, attendu ${profile}`);
      }
    }

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    tab = new OwnedTab(cdp, targetId, sessionId, allowedOrigins);
    await cdp.send('Page.enable', {}, sessionId);

    return await work(tab, { product, profile: commandLine ? (profile ?? 'non déclaré') : 'non vérifiable' });
  } finally {
    // Seulement l'onglet créé ici. Edge et ses autres onglets ne sont pas à nous.
    if (tab) await tab.close().catch(() => {});
    cdp.close();
  }
}
