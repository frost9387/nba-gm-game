/**
 * server.js — NBA GM Engine (back-end securise)
 * ============================================================================
 * Role : servir le front-end statique (public/) ET exposer une route /api/simulate
 *        qui fait le pont vers l'API Anthropic. La cle API reste cote serveur,
 *        jamais exposee au client.
 *
 * Flux : navigateur  --fetch /api/simulate-->  ce serveur  --SDK-->  Anthropic
 *
 * Compatible local (node server.js), Render (serveur persistant) et Vercel
 * (fonction serverless : on exporte l'app et on n'ecoute que si lance directement).
 * ============================================================================
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const csv = require('csv-parser');
const Anthropic = require('@anthropic-ai/sdk');

const { MEGA_PROMPT } = require('./prompts/megaPrompt');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '4096', 10);
const DATA_DIR = path.join(__dirname, 'data');

// Garde-fou : on previent tot si la cle manque (plutot que d'echouer a la 1ere requete).
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '\n[ATTENTION] ANTHROPIC_API_KEY absente. Copie .env.example en .env et ' +
    'renseigne ta cle, sinon /api/simulate renverra une erreur 500.\n'
  );
}

// Client Anthropic. Le SDK lit ANTHROPIC_API_KEY automatiquement, mais on est
// explicite. Timeout genereux car une simulation peut etre longue a generer.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120 * 1000, // 120 s
  maxRetries: 2,       // re-essaie en cas d'erreur reseau transitoire
});

const app = express();

// ---------------------------------------------------------------------------
// 2. Middlewares
// ---------------------------------------------------------------------------
app.use(cors());                          // autorise les requetes cross-origin
app.use(express.json({ limit: '2mb' }));  // parse le corps JSON des requetes
app.use(express.static(path.join(__dirname, 'public'))); // sert le front-end

// ---------------------------------------------------------------------------
// 3. Lecture des fichiers CSV (avec cache memoire)
// ---------------------------------------------------------------------------
// Les CSV de la ligue sont statiques pendant la duree de vie du serveur : on les
// met en cache pour eviter de relire le disque a chaque requete.
const csvCache = new Map();

/**
 * Lit un CSV du dossier /data et renvoie un tableau d'objets.
 * Detecte automatiquement le separateur ';' ou ',' (certains exports NBA usent ';').
 * @param {string} fileName  ex: "nba_draft_2026_prospects.csv"
 * @returns {Promise<Array<Object>>}
 */
function readCsv(fileName) {
  if (csvCache.has(fileName)) {
    return Promise.resolve(csvCache.get(fileName));
  }

  return new Promise((resolve, reject) => {
    const filePath = path.join(DATA_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      return reject(new Error(`Fichier introuvable : ${fileName}`));
    }

    // Detection du separateur sur la 1ere ligne.
    const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0] || '';
    const separator = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';

    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv({ separator }))
      .on('data', (row) => rows.push(row))
      .on('end', () => {
        csvCache.set(fileName, rows);
        resolve(rows);
      })
      .on('error', reject);
  });
}

/**
 * Construit un extrait textuel compact d'un ou plusieurs CSV pour l'injecter dans
 * le prompt. On limite le nombre de lignes pour maitriser le cout en tokens.
 * @param {string[]} fileNames
 * @param {number} maxRowsPerFile
 * @returns {Promise<string>}
 */
async function buildDataContext(fileNames, maxRowsPerFile = 200) {
  const blocks = [];

  for (const name of fileNames) {
    try {
      const rows = await readCsv(name);
      const sliced = rows.slice(0, maxRowsPerFile);
      blocks.push(
        `### Donnees : ${name} (${sliced.length}/${rows.length} lignes)\n` +
        '```csv\n' +
        [Object.keys(sliced[0] || {}).join(',')]   // en-tete
          .concat(sliced.map((r) => Object.values(r).join(',')))
          .join('\n') +
        '\n```'
      );
    } catch (err) {
      blocks.push(`### Donnees : ${name} — INDISPONIBLE (${err.message})`);
    }
  }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// 4. Routes utilitaires
// ---------------------------------------------------------------------------

// Verification de sante (utile pour Render/Vercel et le debug).
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    keyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    csvFiles: fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.csv')) : [],
  });
});

// ---------------------------------------------------------------------------
// 5. Route principale : /api/simulate
// ---------------------------------------------------------------------------
/**
 * Corps attendu (JSON) :
 * {
 *   "prompt":    "Texte de la demande du GM (obligatoire)",
 *   "files":     ["nba_draft_2026_prospects.csv"],   // optionnel : CSV a injecter
 *   "history":   [{ "role": "user"|"assistant", "content": "..." }], // optionnel
 *   "gameState": { ... }                              // optionnel : etat de partie cote client
 * }
 */
app.post('/api/simulate', async (req, res) => {
  try {
    const { prompt, files = [], history = [], gameState = null } = req.body || {};

    // --- Validation des entrees ---
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        error: 'Champ "prompt" manquant ou invalide.',
      });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: 'Cle API non configuree cote serveur (ANTHROPIC_API_KEY).',
      });
    }

    // --- Assemblage du contexte de donnees (CSV) ---
    let dataContext = '';
    if (Array.isArray(files) && files.length > 0) {
      // Securite : on n'autorise que des noms de fichiers du dossier /data,
      // pas de chemins (../) pour eviter toute traversee de repertoire.
      const safe = files.filter((f) => /^[\w.-]+\.csv$/.test(f));
      dataContext = await buildDataContext(safe);
    }

    // --- Construction du message utilisateur final ---
    const userContent =
      (gameState ? `Etat de la partie (JSON) :\n\`\`\`json\n${JSON.stringify(gameState)}\n\`\`\`\n\n` : '') +
      (dataContext ? `${dataContext}\n\n` : '') +
      `Demande du GM :\n${prompt}`;

    // --- Historique de conversation (multi-tours) ---
    const messages = [
      ...history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
        .map((m) => ({ role: m.role, content: String(m.content) })),
      { role: 'user', content: userContent },
    ];

    // --- Appel a l'API Anthropic ---
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: MEGA_PROMPT,   // les regles du moteur, cote serveur uniquement
      messages,
    });

    // On concatene les blocs texte de la reponse.
    const text = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return res.json({
      ok: true,
      model: response.model,
      result: text,
      usage: response.usage, // tokens consommes (utile pour suivre le cout)
    });
  } catch (err) {
    // Gestion fine des erreurs renvoyees par le SDK Anthropic.
    console.error('[/api/simulate] erreur :', err);

    const status = err.status || 500;
    const message =
      err.status === 401 ? 'Cle API invalide ou revoquee.' :
      err.status === 429 ? 'Limite de requetes atteinte (rate limit). Reessaie dans un instant.' :
      err.name === 'APIConnectionTimeoutError' ? 'Anthropic a mis trop de temps a repondre (timeout).' :
      err.message || 'Erreur interne lors de la simulation.';

    return res.status(status).json({ ok: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// 6. Fallback : toute autre route renvoie l'app (utile pour le routing front)
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// 7. Demarrage
// ---------------------------------------------------------------------------
// On n'ecoute que si le fichier est lance directement (node server.js).
// Sur Vercel, l'app est importee comme handler serverless : pas de listen().
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  NBA GM Engine demarre  →  http://localhost:${PORT}`);
    console.log(`  Modele : ${MODEL}`);
    console.log(`  Cle API : ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'MANQUANTE'}\n`);
  });
}

module.exports = app;
