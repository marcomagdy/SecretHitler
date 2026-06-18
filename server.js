'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// --- Database -------------------------------------------------------------

const db = new DatabaseSync(path.join(__dirname, 'secret_hitler.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id            TEXT PRIMARY KEY,
    current_round INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS players (
    id        TEXT PRIMARY KEY,
    game_id   TEXT NOT NULL,
    name      TEXT NOT NULL,
    role      TEXT,
    joined_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id);
`);

// --- Game constants -------------------------------------------------------

const ROLES = new Set(['liberal', 'fascist', 'hitler']);

// Canonical Secret Hitler role distribution, keyed by player count.
// Format: [ Liberals, Fascists (excluding Hitler), Hitler ].
const DIST = {
  5: [3, 1, 1],
  6: [4, 1, 1],
  7: [4, 2, 1],
  8: [5, 2, 1],
  9: [5, 3, 1],
  10: [6, 3, 1],
};

// Code alphabet omits I and O to avoid confusion with 1 and 0.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateGameCode() {
  const exists = db.prepare('SELECT 1 FROM games WHERE id = ?');
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!exists.get(code)) return code;
  }
  throw new Error('Could not generate a unique game code');
}

// Build the private "who is who" reveal for a single player, following the
// real Secret Hitler rules.
function buildReveal(you, players) {
  const playerCount = players.length;

  if (you.role === 'fascist') {
    return {
      role: 'fascist',
      teammates: players
        .filter((p) => p.role === 'fascist' && p.id !== you.id)
        .map((p) => p.name),
      hitler: players.filter((p) => p.role === 'hitler').map((p) => p.name),
    };
  }

  if (you.role === 'hitler') {
    // Hitler only learns the Fascist in 5–6 player games.
    if (playerCount >= 5 && playerCount <= 6) {
      return {
        role: 'hitler',
        knowsFascists: true,
        fascists: players.filter((p) => p.role === 'fascist').map((p) => p.name),
      };
    }
    return { role: 'hitler', knowsFascists: false, fascists: [] };
  }

  return { role: 'liberal' };
}

// --- App ------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const normCode = (s) => String(s || '').trim().toUpperCase();

function pruneOldGames() {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000; // 12 hours ago
  const old = db.prepare('SELECT id FROM games WHERE created_at < ?').all(cutoff);
  if (old.length === 0) return;
  const ids = old.map((g) => g.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM players WHERE game_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM games WHERE id IN (${placeholders})`).run(...ids);
  console.log(`Pruned ${ids.length} old game(s): ${ids.join(', ')}`);
}

// Create a game session.
app.post('/api/games', (req, res) => {
  const id = generateGameCode();
  db.prepare('INSERT INTO games (id, current_round, created_at) VALUES (?, 1, ?)')
    .run(id, Date.now());

  // ~1-in-10 chance to prune games older than 12 hours.
  if (crypto.randomInt(1, 11) === 7) pruneOldGames();

  res.json({ gameId: id });
});

// Join a game with a display name.
app.post('/api/games/:id/join', (req, res) => {
  const gameId = normCode(req.params.id);
  const name = String(req.body?.name || '').trim();

  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) {
    return res.status(404).json({ error: 'Game not found' });
  }
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 40) return res.status(400).json({ error: 'Name is too long' });

  const playerId = crypto.randomUUID();
  db.prepare(
    'INSERT INTO players (id, game_id, name, role, joined_at) VALUES (?, ?, ?, NULL, ?)'
  ).run(playerId, gameId, name, Date.now());

  res.json({ playerId, gameId });
});

// Remove a player from the game (they left voluntarily).
app.delete('/api/games/:id/players/:playerId', (req, res) => {
  const gameId = normCode(req.params.id);
  const { playerId } = req.params;

  const info = db
    .prepare('DELETE FROM players WHERE id = ? AND game_id = ?')
    .run(playerId, gameId);

  if (info.changes === 0) return res.status(404).json({ error: 'Player not found' });
  res.json({ ok: true });
});

// Submit (or change) the calling player's role for the current round.
app.post('/api/games/:id/role', (req, res) => {
  const gameId = normCode(req.params.id);
  const { playerId, role } = req.body || {};

  if (!ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
  const player = db
    .prepare('SELECT id FROM players WHERE id = ? AND game_id = ?')
    .get(playerId, gameId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  db.prepare('UPDATE players SET role = ? WHERE id = ?').run(role, playerId);
  res.json({ ok: true });
});

// Poll the current state, tailored to the requesting player.
app.get('/api/games/:id/state', (req, res) => {
  const gameId = normCode(req.params.id);
  const playerId = req.query.playerId;

  const game = db
    .prepare('SELECT id, current_round FROM games WHERE id = ?')
    .get(gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const players = db
    .prepare('SELECT id, name, role FROM players WHERE game_id = ? ORDER BY joined_at')
    .all(gameId);

  const you = players.find((p) => p.id === playerId) || null;
  const allChosen = players.length > 0 && players.every((p) => p.role != null);

  let results = null;
  let expected = null;
  let reveal = null;

  if (allChosen) {
    const counts = { liberal: 0, fascist: 0, hitler: 0 };
    for (const p of players) counts[p.role]++;
    const playerCount = players.length;
    results = { ...counts, playerCount };

    const d = DIST[playerCount];
    expected = d ? { liberal: d[0], fascist: d[1], hitler: d[2] } : null;

    if (you) reveal = buildReveal(you, players);
  }

  res.json({
    gameId,
    round: game.current_round,
    players: players.map((p) => ({ name: p.name, ready: p.role != null })),
    allChosen,
    you: you ? { name: you.name, role: you.role } : null,
    results,
    expected,
    reveal,
  });
});

// Reset all roles for a new round while keeping the players/names.
app.post('/api/games/:id/new-round', (req, res) => {
  const gameId = normCode(req.params.id);
  const { playerId } = req.body || {};

  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) {
    return res.status(404).json({ error: 'Game not found' });
  }
  const player = db
    .prepare('SELECT id FROM players WHERE id = ? AND game_id = ?')
    .get(playerId, gameId);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  db.prepare('UPDATE players SET role = NULL WHERE game_id = ?').run(gameId);
  db.prepare('UPDATE games SET current_round = current_round + 1 WHERE id = ?').run(gameId);

  const round = db
    .prepare('SELECT current_round FROM games WHERE id = ?')
    .get(gameId).current_round;
  res.json({ ok: true, round });
});

const os = require('node:os');

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddress();
  console.log(`Secret Hitler role app running:`);
  console.log(`  Local  → http://localhost:${PORT}`);
  if (lan) console.log(`  Network → http://${lan}:${PORT}  ← share this with other players`);
});
