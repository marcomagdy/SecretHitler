# Secret Hitler — Role Assignment App

A lightweight web companion for in-person games of **Secret Hitler**. Each player
secretly enters the role card they drew, and the app:

- confirms the role **distribution is correct** for the player count (catches setup mistakes), and
- privately tells the **Fascist team** who their teammates and Hitler are — without anyone speaking.

It is a coordination + validation helper, not the full game engine.

## Requirements

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module — no native build step).
  Installed via `brew install node`.
- That's it. The only npm dependency is `express`.

## Setup & run

```bash
npm install      # installs express
npm start        # serves on http://localhost:3000
```

Open `http://localhost:3000` on each player's phone/laptop (same network), or open
multiple browser tabs to try it solo.

Roles are stored in a SQLite file `secret_hitler.db` created next to `server.js`.
Delete that file to wipe all games.

## How a game flows

1. **Start a game** → you get a 6-character code to share. **Join a game** → enter that code.
2. Enter your **name**.
3. Choose the **role** you drew: Liberal, Fascist, or Hitler.
4. The app polls the server until **everyone has chosen**.
5. **Results** show how many players picked each role, checked against the standard
   Secret Hitler distribution for that player count.
6. **Fascists** see each other plus Hitler. **Hitler** learns the Fascist only in 5–6
   player games (official rules). **Liberals** see nothing.
7. **New round** clears all roles but keeps the players/names in the session.

## Standard distribution (used for the confirmation check)

| Players | Liberals | Fascists | Hitler |
|--------:|:--------:|:--------:|:------:|
| 5       | 3        | 1        | 1      |
| 6       | 4        | 1        | 1      |
| 7       | 4        | 2        | 1      |
| 8       | 5        | 2        | 1      |
| 9       | 5        | 3        | 1      |
| 10      | 6        | 3        | 1      |

## HTTP API

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| POST | `/api/games` | — | Create a session, returns `{ gameId }` |
| POST | `/api/games/:id/join` | `{ name }` | Join, returns `{ playerId }` |
| POST | `/api/games/:id/role` | `{ playerId, role }` | Submit a role |
| GET  | `/api/games/:id/state?playerId=…` | — | Poll tailored state |
| POST | `/api/games/:id/new-round` | `{ playerId }` | Reset roles, keep players |
