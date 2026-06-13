/**
 * api-client.js — Pont front-end vers le back-end securise.
 * ----------------------------------------------------------------------------
 * Le client n'appelle JAMAIS Anthropic directement : il passe par /api/simulate.
 * La cle API n'existe que cote serveur.
 *
 * Expose une fonction globale : window.simulate(options)
 * ----------------------------------------------------------------------------
 */
(function () {
  'use strict';

  /**
   * Envoie une demande de simulation au serveur Node.
   * @param {Object} options
   * @param {string} options.prompt        Demande du GM (obligatoire).
   * @param {string[]} [options.files]      CSV a injecter, ex: ["nba_draft_2026_prospects.csv"].
   * @param {Array}  [options.history]      Historique [{role, content}, ...].
   * @param {Object} [options.gameState]    Etat de partie a transmettre au moteur.
   * @returns {Promise<{ok:boolean, result?:string, error?:string, usage?:object}>}
   */
  async function simulate(options) {
    const { prompt, files = [], history = [], gameState = null } = options || {};

    if (!prompt) {
      return { ok: false, error: 'Le champ "prompt" est obligatoire.' };
    }

    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, files, history, gameState }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        return { ok: false, error: data.error || `Erreur serveur (${res.status}).` };
      }
      return data; // { ok, result, model, usage }
    } catch (err) {
      // Erreur reseau (serveur eteint, pas de connexion, etc.)
      return { ok: false, error: `Impossible de joindre le serveur : ${err.message}` };
    }
  }

  // Petit helper de demo : verifie que le back-end repond.
  async function health() {
    try {
      const res = await fetch('/api/health');
      return await res.json();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Exposition globale.
  window.simulate = simulate;
  window.gmEngineHealth = health;

  console.log('[NBA GM Engine] api-client.js charge. Utilise window.simulate({prompt, files}).');
})();
