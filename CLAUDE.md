# Specter Chess — Project Brief

## Game Concept

A variant of chess where your opponent's most recent move is hidden from you. You must deduce their move through reasoning and a limited information tool called the **spyglass**.

---

## Rules

### Hidden Information
- After your opponent moves, you do **not** see their updated piece positions.
- You always see your opponent's pieces as they were **before their most recent move** (1 opponent-turn stale).
- At game start, both players see the standard starting position. White will take two of their own turns before seeing any change in Black's pieces (because Black needs to complete 2 turns before White sees their first move).
- Formally: after opponent completes turn N, you see opponent's board state after turn N-1.

### The Spyglass
- Once per turn, **at the start of your turn** (before making your move), you may use the spyglass on any square.
- The spyglass reveals the **true current occupant** of that square — piece type and color — rendered as it would normally appear.
- If a piece is revealed, it **remains visible** on subsequent turns, overriding the stale snapshot at that square.
- When the opponent moves that revealed piece, the server notifies you that the confirmed position is now stale (without revealing where the piece went). The confirmed position is cleared.

### Move Attempts
- Players may attempt any move they believe **might** be valid.
- The server validates all moves against the **true board state**.
- If a move is invalid (e.g., path blocked by a hidden piece), it is silently rejected — no information about why is revealed. The player must use the spyglass to investigate.
- If a player moves to a square they thought was empty but was actually occupied by an opponent's piece, the opponent's piece is **captured**.

### Check
- If you are put in check, the UI **notifies you**, even if you cannot see which opponent piece is threatening your king.
- You must make a move that resolves the check. This may require trial and error or using the spyglass to find the attacker.

### En Passant
- En passant is available but not automatically surfaced. A player can attempt a diagonal pawn move to an apparently empty square; the server will confirm if it is valid (i.e., en passant is available). Discovery is a trial-and-error process.

### All other rules are standard chess.

---

## Player View Model

Each player's view of opponent pieces has two layers:

| Layer | Description |
|---|---|
| **Stale snapshot** | Opponent's positions before their latest move. Advances one step each time the opponent completes a turn. |
| **Confirmed positions** | Squares revealed by spyglass. Shown at true current position, overriding the snapshot for that square. Cleared when the piece moves. |

### Server snapshot update rule
When a player **begins** their turn, the server snapshots their current piece positions → this becomes what the opponent sees after that turn ends.

---

## Architecture

### Guiding Constraint
Hidden information requires a **server-authoritative design**. Each client receives a filtered view of game state. The server holds the true board state and validates all moves.

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript + Vite |
| Backend | Node.js + Express + Socket.io + TypeScript |
| Chess engine | `chess.js` for legal move generation + Specter Chess layer on top |
| Monorepo | pnpm workspaces |
| Database (later) | SQLite → PostgreSQL |
| Auth (later) | JWT |

### Monorepo Structure
```
specter-chess/
  packages/
    shared/    # Game logic, types, chess.js wrapper (used by both client and server)
    client/    # React app
    server/    # Express + Socket.io
```

Shared types (e.g. `Move`, `GameState`, `SpyglassResult`, `PlayerView`) are defined once in `shared/` and used by both client and server.

### Local Development (2-tab play)
Both browser tabs connect to the same `localhost` server. One tab joins as Player 1, the other as Player 2. This is architecturally identical to the production setup — no throwaway work.

### Move Validation Flow
1. Player selects a piece → client highlights moves valid per **visible board state only**
2. Player chooses a destination (speculative moves allowed)
3. Server validates against **true board state** → responds `valid` or `invalid`
4. If valid: server executes move, sends updated filtered views to both players
5. If invalid: move silently rejected

### Socket.io Events (planned)
- Player connects → joins game session as White or Black
- `move_attempt` → server validates and responds
- `spyglass_query` → server returns piece at square (or empty)
- `game_state_update` → server pushes filtered view to each player after each action
- `check_notification` → server notifies player they are in check
- `confirmed_position_invalidated` → server notifies player a spyglass-confirmed piece has moved

---

## Roadmap

1. **Now:** Local 2-tab prototype (monorepo scaffold → shared game logic → server → client UI)
2. **Later:** Deploy to mobile-friendly website
3. **Later:** Matchmaking
4. **Later:** Account system + ELO ratings
