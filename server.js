'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// --- Database -------------------------------------------------------------

// On Glitch, .data/ is the persistent writable directory; elsewhere use __dirname.
const dataDir = path.join(__dirname, '.data');
const DB_PATH = fs.existsSync(dataDir)
  ? path.join(dataDir, 'secret_hitler.db')
  : path.join(__dirname, 'secret_hitler.db');

const db = new DatabaseSync(DB_PATH);
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

  CREATE TABLE IF NOT EXISTS elections (
    id            TEXT PRIMARY KEY,
    game_id       TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    president_id  TEXT NOT NULL,
    chancellor_id TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'voting',   -- 'voting' | 'complete'
    result        TEXT,                             -- 'passed' | 'failed' | NULL
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_elections_game ON elections(game_id);

  CREATE TABLE IF NOT EXISTS votes (
    election_id TEXT NOT NULL,
    player_id   TEXT NOT NULL,
    choice      TEXT NOT NULL,                      -- 'ja' | 'nein'
    PRIMARY KEY (election_id, player_id)
  );
`);

// Add election columns to existing `games` rows (idempotent migration).
{
  const cols = new Set(db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
  const addColumn = (name, def) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE games ADD COLUMN ${name} ${def}`);
  };
  addColumn('phase', "TEXT NOT NULL DEFAULT 'roles'"); // 'roles' | 'play'
  addColumn('election_tracker', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('last_president_id', 'TEXT');
  addColumn('last_chancellor_id', 'TEXT');
}

// --- Game constants -------------------------------------------------------

const ROLES = new Set(['liberal', 'fascist', 'hitler']);
const VOTE_CHOICES = new Set(['ja', 'nein']);
const ELECTION_TRACKER_MAX = 3; // 3 consecutive failed elections = chaos

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
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

function generateGameCode() {
  const exists = db.prepare('SELECT 1 FROM games WHERE id = ?');
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
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

// The single active (not-yet-finalized) election for a game, if any.
function getActiveElection(gameId) {
  return db
    .prepare(
      `SELECT * FROM elections
       WHERE game_id = ? AND status = 'voting'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(gameId);
}

// Chancellor nominees that are term-limited by the last elected government.
// In games with <=5 players only the last Chancellor is barred; otherwise the
// last President and last Chancellor are both barred.
function ineligibleChancellorIds(game, playerCount) {
  const ids = [];
  if (game.last_chancellor_id) ids.push(game.last_chancellor_id);
  if (playerCount > 5 && game.last_president_id) ids.push(game.last_president_id);
  return ids;
}

// Build the per-player election view returned by the state endpoint while in
// the 'play' phase. `players` are the current players (join order).
function buildElectionView(game, players, you) {
  const tracker = game.election_tracker || 0;
  const lastGovernment =
    game.last_president_id && game.last_chancellor_id
      ? {
          presidentName: nameOf(players, game.last_president_id),
          chancellorName: nameOf(players, game.last_chancellor_id),
        }
      : null;

  const election = getActiveElection(game.id);
  if (!election) {
    // Nomination sub-phase: anyone may open an election.
    return {
      active: false,
      candidates: players.map((p) => ({ id: p.id, name: p.name })),
      ineligibleChancellorIds: ineligibleChancellorIds(game, players.length),
      lastGovernment,
      electionTracker: tracker,
    };
  }

  // Voting sub-phase. Count ballots from current players only.
  const ballotRows = db
    .prepare('SELECT player_id, choice FROM votes WHERE election_id = ?')
    .all(election.id);
  const byPlayer = new Map(ballotRows.map((b) => [b.player_id, b.choice]));

  const currentBallots = players
    .filter((p) => byPlayer.has(p.id))
    .map((p) => ({ name: p.name, choice: byPlayer.get(p.id) }));
  const votedCount = currentBallots.length;
  const totalPlayers = players.length;
  const allVoted = totalPlayers > 0 && votedCount === totalPlayers;

  const view = {
    active: true,
    seq: election.seq,
    presidentId: election.president_id,
    presidentName: nameOf(players, election.president_id),
    chancellorId: election.chancellor_id,
    chancellorName: nameOf(players, election.chancellor_id),
    status: election.status,
    youVoted: you ? byPlayer.has(you.id) : false,
    yourVote: you ? byPlayer.get(you.id) || null : null,
    // Who has voted (NOT how) — for the live progress roster during voting.
    roster: players.map((p) => ({ name: p.name, voted: byPlayer.has(p.id) })),
    votedCount,
    totalPlayers,
    allVoted,
    tally: null,
    result: null,
    ballots: null,
    electionTracker: tracker,
  };

  if (allVoted) {
    const ja = currentBallots.filter((b) => b.choice === 'ja').length;
    const nein = votedCount - ja;
    view.tally = { ja, nein };
    view.result = ja > nein ? 'passed' : 'failed'; // tie fails
    view.ballots = currentBallots; // public reveal
  }
  return view;
}

function nameOf(players, id) {
  const p = players.find((x) => x.id === id);
  return p ? p.name : '(left)';
}

// --- App ------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Invite links (/join/<code>) load the single-page app, which reads the code
// from the path and sends the visitor straight to entering their name.
app.get('/join/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
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

  const phase = game.phase || 'roles';
  const election = phase === 'play' ? buildElectionView(game, players, you) : null;

  res.json({
    gameId,
    round: game.current_round,
    phase,
    players: players.map((p) => ({ name: p.name, ready: p.role != null })),
    allChosen,
    you: you ? { id: you.id, name: you.name, role: you.role } : null,
    results,
    expected,
    reveal,
    election,
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
  // Fully reset to the setup phase: clear elections, votes, tracker, term limits.
  db.prepare(
    'DELETE FROM votes WHERE election_id IN (SELECT id FROM elections WHERE game_id = ?)'
  ).run(gameId);
  db.prepare('DELETE FROM elections WHERE game_id = ?').run(gameId);
  db.prepare(
    `UPDATE games SET current_round = current_round + 1, phase = 'roles',
       election_tracker = 0, last_president_id = NULL, last_chancellor_id = NULL
     WHERE id = ?`
  ).run(gameId);

  const round = db
    .prepare('SELECT current_round FROM games WHERE id = ?')
    .get(gameId).current_round;
  res.json({ ok: true, round });
});

// --- Elections ------------------------------------------------------------

// Helper: load a game + verify the caller is a current player. Sends the error
// response and returns null on failure; returns { game, players } on success.
function requirePlayer(req, res) {
  const gameId = normCode(req.params.id);
  const { playerId } = req.body || {};
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!game) { res.status(404).json({ error: 'Game not found' }); return null; }
  const players = db
    .prepare('SELECT id, name, role FROM players WHERE game_id = ? ORDER BY joined_at')
    .all(gameId);
  if (!players.some((p) => p.id === playerId)) {
    res.status(404).json({ error: 'Player not found' });
    return null;
  }
  return { game, players, gameId, playerId };
}

// Move the game into the election ('play') phase. Idempotent; any player.
app.post('/api/games/:id/begin-play', (req, res) => {
  const ctx = requirePlayer(req, res);
  if (!ctx) return;
  db.prepare("UPDATE games SET phase = 'play' WHERE id = ?").run(ctx.gameId);
  res.json({ ok: true });
});

// Open an election by nominating a President + Chancellor. Any player.
app.post('/api/games/:id/nominate', (req, res) => {
  const ctx = requirePlayer(req, res);
  if (!ctx) return;
  const { game, players, gameId } = ctx;
  const { presidentId, chancellorId } = req.body || {};

  if (game.phase !== 'play') return res.status(409).json({ error: 'Game is not in the election phase' });
  if (getActiveElection(gameId)) return res.status(409).json({ error: 'An election is already underway' });

  const isPlayer = (id) => players.some((p) => p.id === id);
  if (!isPlayer(presidentId) || !isPlayer(chancellorId)) {
    return res.status(400).json({ error: 'President and Chancellor must both be players' });
  }
  if (presidentId === chancellorId) {
    return res.status(400).json({ error: 'President and Chancellor must be different players' });
  }
  if (ineligibleChancellorIds(game, players.length).includes(chancellorId)) {
    return res.status(400).json({ error: 'That player is term-limited and cannot be Chancellor' });
  }

  const seqRow = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM elections WHERE game_id = ?')
    .get(gameId);
  db.prepare(
    `INSERT INTO elections (id, game_id, seq, president_id, chancellor_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'voting', ?)`
  ).run(crypto.randomUUID(), gameId, seqRow.m + 1, presidentId, chancellorId, Date.now());

  res.json({ ok: true });
});

// Cast (or change) a Ja/Nein vote on the active election.
app.post('/api/games/:id/vote', (req, res) => {
  const ctx = requirePlayer(req, res);
  if (!ctx) return;
  const { gameId, playerId } = ctx;
  const { choice } = req.body || {};

  if (!VOTE_CHOICES.has(choice)) return res.status(400).json({ error: 'Invalid vote' });
  const election = getActiveElection(gameId);
  if (!election) return res.status(409).json({ error: 'No active election' });

  db.prepare(
    `INSERT INTO votes (election_id, player_id, choice) VALUES (?, ?, ?)
     ON CONFLICT(election_id, player_id) DO UPDATE SET choice = excluded.choice`
  ).run(election.id, playerId, choice);

  res.json({ ok: true });
});

// Finalize the active election and advance the game. Any player.
app.post('/api/games/:id/election/advance', (req, res) => {
  const ctx = requirePlayer(req, res);
  if (!ctx) return;
  const { game, players, gameId } = ctx;

  const election = getActiveElection(gameId);
  if (!election) return res.status(409).json({ error: 'No active election to advance' });

  // Authoritative tally over current players only.
  const ballots = db
    .prepare('SELECT player_id, choice FROM votes WHERE election_id = ?')
    .all(election.id);
  const present = new Set(players.map((p) => p.id));
  const ja = ballots.filter((b) => present.has(b.player_id) && b.choice === 'ja').length;
  const nein = ballots.filter((b) => present.has(b.player_id) && b.choice === 'nein').length;
  const passed = ja > nein; // tie fails

  db.prepare("UPDATE elections SET status = 'complete', result = ? WHERE id = ?")
    .run(passed ? 'passed' : 'failed', election.id);

  if (passed) {
    db.prepare(
      `UPDATE games SET election_tracker = 0,
         last_president_id = ?, last_chancellor_id = ? WHERE id = ?`
    ).run(election.president_id, election.chancellor_id, gameId);
  } else {
    const tracker = (game.election_tracker || 0) + 1;
    if (tracker >= ELECTION_TRACKER_MAX) {
      // Chaos: reset the tracker and clear term limits.
      db.prepare(
        `UPDATE games SET election_tracker = 0,
           last_president_id = NULL, last_chancellor_id = NULL WHERE id = ?`
      ).run(gameId);
    } else {
      db.prepare('UPDATE games SET election_tracker = ? WHERE id = ?').run(tracker, gameId);
    }
  }

  res.json({ ok: true, result: passed ? 'passed' : 'failed' });
});

// Database stats — total games and player count per game.
app.get('/api/stats', (req, res) => {
  const games = db.prepare(`
    SELECT g.id, g.current_round, g.created_at,
           COUNT(p.id) AS player_count
    FROM games g
    LEFT JOIN players p ON p.game_id = g.id
    GROUP BY g.id
    ORDER BY g.created_at DESC
  `).all();

  res.json({
    gameCount: games.length,
    games: games.map((g) => ({
      gameId: g.id,
      round: g.current_round,
      playerCount: g.player_count,
      createdAt: new Date(g.created_at).toISOString(),
    })),
  });
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
