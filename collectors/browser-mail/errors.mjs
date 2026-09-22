// Statuts de collecteur, isolés de tout module Node.
//
// providers/*.mjs doit rester importable dans un navigateur : c'est ce qui
// permet à sa page témoin d'exécuter les vrais sélecteurs contre un vrai DOM,
// au lieu de vérifier une copie qui dériverait en silence.

/** Statuts acceptés par `collector.status` — voir ingest/schema.md. */
export const STATUSES = ['ok', 'partial', 'needs_user', 'wrong_account', 'unavailable', 'error'];

/** Échec attendu, porteur d'un statut de collecteur. */
export class CollectorError extends Error {
  constructor(status, message) {
    super(message);
    this.status = STATUSES.includes(status) ? status : 'error';
  }
}
