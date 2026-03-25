import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Filter } from 'bad-words';
import {
  SpecterChessGame,
  type Color,
  type Move,
  type Square,
  type BotDifficulty,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type InterServerEvents,
  type SocketData,
  type GameListing,
  type PlayerRating,
} from '@specter-chess/shared';
import * as db from './db';
import { getBotMoveCandidates, getBotSpyglassTarget, getBotDelay } from './bot';
import * as gamedb from './gamedb';
import { initDb } from './db';
import { initGameDb } from './gamedb';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const app = express();
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
  httpServer,
  { cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] } }
);

// ─── Profanity filter ─────────────────────────────────────────────────────────

const profanityFilter = new Filter();
const profanityList: string[] = ((profanityFilter as any).list as string[]) ?? [];

function containsProfanity(text: string): boolean {
  const lower = text.toLowerCase();
  return profanityList.some(word => lower.includes(word));
}

function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name cannot be empty.';
  if (trimmed.length > 20) return 'Name must be 20 characters or fewer.';
  if (!/^[\w\s'\-\.]+$/i.test(trimmed)) return 'Name contains invalid characters.';
  if (containsProfanity(trimmed)) return 'That name is not allowed.';
  return null;
}

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Game sessions ────────────────────────────────────────────────────────────

interface GameSession {
  game: SpecterChessGame;
  sockets: Partial<Record<Color, string>>;
  names: Record<Color, string>;
  uuids: Partial<Record<Color, string>>;
  elos: Record<Color, number>;
  eloRecorded: boolean;
  timeControl: number;
  timeRemaining: Record<Color, number>;
  turnStartTime: number | null;
  timerHandle: ReturnType<typeof setTimeout> | null;
  drawOfferedBy: Color | null;
  botDifficulty: BotDifficulty | null;
  botMoveHandle: ReturnType<typeof setTimeout> | null;
  gameStartTime: number | null;
}

const sessions = new Map<string, GameSession>();
const openGames = new Map<string, { createdAt: number; timeControl: number }>();
let onlineCount = 0;

async function broadcastStats() {
  io.emit('stats_update', { onlineCount, gamesPlayed: await db.getGamesPlayed() });
}

// ─── ELO ─────────────────────────────────────────────────────────────────────

async function recordGameResult(gameId: string, session: GameSession): Promise<void> {
  if (session.eloRecorded) return;
  session.eloRecorded = true;

  await db.incrementGamesPlayed();
  void broadcastStats();

  const whiteUuid = session.uuids.white;
  const blackUuid = session.uuids.black;
  if (!whiteUuid || !blackUuid) return;

  const winner = session.game.winner;
  const whiteResult: 0 | 0.5 | 1 = winner === 'white' ? 1 : winner === 'black' ? 0 : 0.5;
  const blackResult: 0 | 0.5 | 1 = winner === 'black' ? 1 : winner === 'white' ? 0 : 0.5;

  const [whiteRecord, blackRecord] = await Promise.all([
    db.getOrCreatePlayer(whiteUuid),
    db.getOrCreatePlayer(blackUuid),
  ]);

  const newWhiteElo = db.calcNewElo(whiteRecord.elo, blackRecord.elo, whiteResult);
  const newBlackElo = db.calcNewElo(blackRecord.elo, whiteRecord.elo, blackResult);

  const toDbResult = (r: 0 | 0.5 | 1): 'win' | 'loss' | 'draw' =>
    r === 1 ? 'win' : r === 0 ? 'loss' : 'draw';

  await gamedb.recordGame({
    gameId,
    player1Uuid: whiteUuid,
    player2Uuid: blackUuid,
    lengthMs: session.gameStartTime !== null ? Date.now() - session.gameStartTime : null,
    outcome: winner === 'white' ? 'white_wins' : winner === 'black' ? 'black_wins' : 'draw',
    setLengthMinutes: session.timeControl / 60,
    player1OrigElo: whiteRecord.elo,
    player1NewElo: newWhiteElo,
    player2OrigElo: blackRecord.elo,
    player2NewElo: newBlackElo,
  });

  const [updatedWhiteRecord, updatedBlackRecord] = await Promise.all([
    db.updateElo(whiteUuid, newWhiteElo, toDbResult(whiteResult)),
    db.updateElo(blackUuid, newBlackElo, toDbResult(blackResult)),
  ]);

  session.elos.white = newWhiteElo;
  session.elos.black = newBlackElo;

  const toRating = (r: db.PlayerRecord): PlayerRating =>
    ({ elo: r.elo, wins: r.wins, losses: r.losses, draws: r.draws });

  const whiteSocketId = session.sockets.white;
  const blackSocketId = session.sockets.black;
  if (whiteSocketId) io.to(whiteSocketId).emit('rating_update', toRating(updatedWhiteRecord));
  if (blackSocketId) io.to(blackSocketId).emit('rating_update', toRating(updatedBlackRecord));
}

// ─── Timer helpers ────────────────────────────────────────────────────────────

function stopTimer(session: GameSession, colorThatMoved: Color) {
  if (session.timerHandle) { clearTimeout(session.timerHandle); session.timerHandle = null; }
  if (session.turnStartTime !== null) {
    const elapsed = Date.now() - session.turnStartTime;
    session.timeRemaining[colorThatMoved] = Math.max(0, session.timeRemaining[colorThatMoved] - elapsed);
    session.turnStartTime = null;
  }
}

function startTimer(gameId: string, session: GameSession) {
  const activeColor = session.game.turn;
  session.turnStartTime = Date.now();
  session.timerHandle = setTimeout(() => {
    if (session.game.isGameOver) return;
    session.game.declareTimeout(activeColor);
    session.timeRemaining[activeColor] = 0;
    session.turnStartTime = null;
    session.timerHandle = null;
    void recordGameResult(gameId, session);
    pushViews(gameId);
  }, session.timeRemaining[activeColor]);
}

function liveTimeRemaining(session: GameSession): { white: number; black: number } {
  const snap = { ...session.timeRemaining };
  if (session.turnStartTime !== null && !session.game.isGameOver) {
    const elapsed = Date.now() - session.turnStartTime;
    snap[session.game.turn] = Math.max(0, snap[session.game.turn] - elapsed);
  }
  return snap;
}

// ─── Bot helpers ──────────────────────────────────────────────────────────────

function scheduleBotMove(gameId: string, session: GameSession) {
  if (!session.botDifficulty || session.game.isGameOver) return;

  const delay = getBotDelay(session.botDifficulty);
  session.botMoveHandle = setTimeout(() => {
    session.botMoveHandle = null;
    if (session.game.isGameOver) return;

    const botColor: Color = 'black';
    const humanSocketId = session.sockets.white;

    // ── Spyglass phase ────────────────────────────────────────────────────────
    let perspectiveFen = session.game.getBotPerspectiveFen();
    let moveFen = perspectiveFen;

    const spyTarget = getBotSpyglassTarget(perspectiveFen);

    if (spyTarget) {
      const spyResult = session.game.useSpyglass(botColor, spyTarget);
      // Notify the human player of the bot's spyglass usage
      if (humanSocketId) io.to(humanSocketId).emit('opponent_spyglass', spyTarget);
      // If a human piece was found, upgrade to the true FEN for the move decision
      if (spyResult?.piece) {
        moveFen = session.game.getFen();
      }
    }

    // ── Move phase ────────────────────────────────────────────────────────────
    const candidates = getBotMoveCandidates(moveFen, session.botDifficulty!, 'b');
    if (candidates.length === 0) return;

    stopTimer(session, botColor);
    session.drawOfferedBy = null;

    let valid = false;
    for (const move of candidates) {
      valid = session.game.attemptMove(botColor, move);
      if (valid) break;
    }
    if (!valid) return; // all candidates rejected

    if (session.game.isGameOver) {
      void recordGameResult(gameId, session);
    } else {
      startTimer(gameId, session);
    }

    pushViews(gameId);

    // Notify human if in check
    if (humanSocketId && !session.game.isGameOver) {
      if (session.game.getPlayerView('white').inCheck) {
        io.to(humanSocketId).emit('check_notification');
      }
    }
  }, delay);
}

// ─── View helpers ─────────────────────────────────────────────────────────────

function broadcastOpenGames() {
  const games: GameListing[] = [];
  for (const [gameId, { createdAt, timeControl }] of openGames.entries()) {
    games.push({ gameId, createdAt, timeControl });
  }
  games.sort((a, b) => a.createdAt - b.createdAt);
  io.emit('open_games_update', games);
}

function getColorForSocket(session: GameSession, socketId: string): Color | null {
  for (const [color, id] of Object.entries(session.sockets)) {
    if (id === socketId) return color as Color;
  }
  return null;
}

function pushViews(gameId: string) {
  const session = sessions.get(gameId);
  if (!session) return;
  const timeRemainingMs = liveTimeRemaining(session);
  for (const [color, socketId] of Object.entries(session.sockets) as [Color, string][]) {
    if (!socketId) continue;
    const opponent: Color = color === 'white' ? 'black' : 'white';
    const view = session.game.getPlayerView(color);
    io.to(socketId).emit('game_state_update', {
      ...view,
      timeRemainingMs,
      playerName: session.names[color],
      opponentName: session.names[opponent],
      playerElo: session.elos[color],
      opponentElo: session.elos[opponent],
      drawOfferPending: session.drawOfferedBy === opponent,
      myDrawOfferPending: session.drawOfferedBy === color,
      isVsBot: session.botDifficulty !== null,
    });
  }
}

// ─── Socket.io ───────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log(`[connect] ${socket.id}`);
  onlineCount++;
  void broadcastStats();

  const games: GameListing[] = [];
  for (const [gameId, { createdAt, timeControl }] of openGames.entries()) {
    games.push({ gameId, createdAt, timeControl });
  }
  games.sort((a, b) => a.createdAt - b.createdAt);
  socket.emit('open_games_update', games);

  // ── Register ──────────────────────────────────────────────────────────────

  socket.on('register', async (uuid: string) => {
    if (!UUID_RE.test(uuid)) return;
    socket.data.uuid = uuid;
    const record = await db.getOrCreatePlayer(uuid);
    // Sync stored name → name last used for this UUID
    if (record.name !== 'Anonymous' && !socket.data.name) {
      socket.data.name = record.name;
    }
    socket.emit('rating_update', {
      elo: record.elo, wins: record.wins, losses: record.losses, draws: record.draws,
    });
  });

  // ── Get open games ────────────────────────────────────────────────────────

  socket.on('get_open_games', () => {
    const games: GameListing[] = [];
    for (const [gameId, { createdAt, timeControl }] of openGames.entries()) {
      games.push({ gameId, createdAt, timeControl });
    }
    games.sort((a, b) => a.createdAt - b.createdAt);
    socket.emit('open_games_update', games);
  });

  // ── Set name ──────────────────────────────────────────────────────────────

  socket.on('set_name', async (name: string) => {
    const error = validateName(name);
    if (error) { socket.emit('name_rejected', error); return; }
    socket.data.name = name.trim();
    if (socket.data.uuid) await db.updatePlayerName(socket.data.uuid, name.trim());
  });

  // ── Create game ───────────────────────────────────────────────────────────

  socket.on('create_game', async (timeControl: number) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let gameId = '';
    for (let i = 0; i < 6; i++) gameId += chars[Math.floor(Math.random() * chars.length)];

    const whiteElo = socket.data.uuid ? (await db.getOrCreatePlayer(socket.data.uuid)).elo : 1200;

    const session: GameSession = {
      game: new SpecterChessGame(),
      sockets: { white: socket.id },
      names: { white: socket.data.name ?? 'White', black: 'Black' },
      uuids: { white: socket.data.uuid },
      elos: { white: whiteElo, black: 1200 },
      eloRecorded: false,
      timeControl,
      timeRemaining: { white: timeControl * 1000, black: timeControl * 1000 },
      turnStartTime: null,
      timerHandle: null,
      drawOfferedBy: null,
      botDifficulty: null,
      botMoveHandle: null,
      gameStartTime: null,
    };
    sessions.set(gameId, session);
    openGames.set(gameId, { createdAt: Date.now(), timeControl });

    socket.data.color = 'white';
    socket.data.gameId = gameId;

    console.log(`[create_game] ${socket.id} created game ${gameId} (${timeControl}s)`);
    socket.emit('game_created', gameId);
    socket.emit('waiting_for_opponent');
    broadcastOpenGames();
  });

  // ── Join game ─────────────────────────────────────────────────────────────

  socket.on('join_game', async (gameId: string) => {
    const session = sessions.get(gameId);
    if (!session) { socket.emit('join_failed', 'Game not found.'); return; }
    if (session.sockets.black) { socket.emit('join_failed', 'Game is already full.'); return; }

    const blackElo = socket.data.uuid ? (await db.getOrCreatePlayer(socket.data.uuid)).elo : 1200;

    session.sockets.black = socket.id;
    session.names.black = socket.data.name ?? 'Black';
    session.uuids.black = socket.data.uuid;
    session.elos.black = blackElo;
    socket.data.color = 'black';
    socket.data.gameId = gameId;

    openGames.delete(gameId);
    session.gameStartTime = Date.now();

    io.to(session.sockets.white!).emit('game_start', 'white');
    io.to(socket.id).emit('game_start', 'black');

    console.log(`[join_game] ${socket.id} joined game ${gameId} as black`);
    startTimer(gameId, session);
    pushViews(gameId);
    broadcastOpenGames();
  });

  // ── Create bot game ───────────────────────────────────────────────────────

  socket.on('create_bot_game', async ({ difficulty, timeControl }: { difficulty: BotDifficulty; timeControl: number }) => {
    if (!socket.data.name) { socket.emit('join_failed', 'Set a name before playing.'); return; }

    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let gameId = '';
    for (let i = 0; i < 6; i++) gameId += chars[Math.floor(Math.random() * chars.length)];

    const diffLabel = difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
    const botElo = difficulty === 'easy' ? 800 : difficulty === 'medium' ? 1200 : 1800;
    const whiteElo = socket.data.uuid ? (await db.getOrCreatePlayer(socket.data.uuid)).elo : 1200;

    const session: GameSession = {
      game: new SpecterChessGame(),
      sockets: { white: socket.id },
      names: { white: socket.data.name ?? 'Player', black: `Bot (${diffLabel})` },
      uuids: { white: socket.data.uuid },
      elos: { white: whiteElo, black: botElo },
      eloRecorded: false,
      timeControl,
      timeRemaining: { white: timeControl * 1000, black: timeControl * 1000 },
      turnStartTime: null,
      timerHandle: null,
      drawOfferedBy: null,
      botDifficulty: difficulty,
      botMoveHandle: null,
      gameStartTime: null,
    };

    sessions.set(gameId, session);
    socket.data.color = 'white';
    socket.data.gameId = gameId;

    console.log(`[create_bot_game] ${socket.id} vs ${difficulty} bot, game ${gameId}`);
    socket.emit('game_start', 'white');
    startTimer(gameId, session);
    pushViews(gameId);
  });

  // ── Move attempt ──────────────────────────────────────────────────────────

  socket.on('move_attempt', (move: Move) => {
    const gameId = socket.data.gameId;
    if (!gameId) return;
    const session = sessions.get(gameId);
    if (!session) return;
    const color = getColorForSocket(session, socket.id);
    if (!color) return;

    if (session.timerHandle) { clearTimeout(session.timerHandle); session.timerHandle = null; }

    const valid = session.game.attemptMove(color, move);
    if (!valid) {
      socket.emit('move_rejected');
      if (!session.game.isGameOver) startTimer(gameId, session);
      return;
    }

    // A move implicitly declines any pending draw offer
    session.drawOfferedBy = null;

    stopTimer(session, color);

    if (session.game.isGameOver) {
      void recordGameResult(gameId, session);
    } else if (session.botDifficulty) {
      // Bot's turn — scheduler handles its own startTimer after the move
      startTimer(gameId, session); // keep bot's clock ticking during think delay
      scheduleBotMove(gameId, session);
    } else {
      startTimer(gameId, session);
    }

    pushViews(gameId);

    const nextTurn = session.game.turn;
    const nextSocketId = session.sockets[nextTurn];
    if (nextSocketId && !session.game.isGameOver) {
      const view = session.game.getPlayerView(nextTurn);
      if (view.inCheck) io.to(nextSocketId).emit('check_notification');
    }
  });

  // ── Spyglass ──────────────────────────────────────────────────────────────

  socket.on('spyglass_query', ({ square }: { square: Square }) => {
    const gameId = socket.data.gameId;
    if (!gameId) return;
    const session = sessions.get(gameId);
    if (!session) return;
    const color = getColorForSocket(session, socket.id);
    if (!color) return;

    const result = session.game.useSpyglass(color, square);
    if (!result) { socket.emit('spyglass_rejected', 'Spyglass already used this turn'); return; }

    socket.emit('spyglass_result', result);
    const opponent: Color = color === 'white' ? 'black' : 'white';
    const opponentSpySocketId = session.sockets[opponent];
    if (opponentSpySocketId) io.to(opponentSpySocketId).emit('opponent_spyglass', square);
    const view = session.game.getPlayerView(color);
    socket.emit('game_state_update', {
      ...view,
      timeRemainingMs: liveTimeRemaining(session),
      playerName: session.names[color],
      opponentName: session.names[opponent],
      playerElo: session.elos[color],
      opponentElo: session.elos[opponent],
      drawOfferPending: session.drawOfferedBy === opponent,
      myDrawOfferPending: session.drawOfferedBy === color,
      isVsBot: session.botDifficulty !== null,
    });
  });

  // ── Resign ────────────────────────────────────────────────────────────────

  socket.on('resign', () => {
    const gameId = socket.data.gameId;
    if (!gameId) return;
    const session = sessions.get(gameId);
    if (!session) return;
    const color = getColorForSocket(session, socket.id);
    if (!color) return;
    if (session.game.isGameOver) return;

    if (session.timerHandle) { clearTimeout(session.timerHandle); session.timerHandle = null; }
    stopTimer(session, color);
    session.drawOfferedBy = null;
    session.game.declareTimeout(color); // resign = this player loses
    recordGameResult(gameId, session);
    pushViews(gameId);
  });

  // ── Draw ──────────────────────────────────────────────────────────────────

  socket.on('offer_draw', () => {
    const gameId = socket.data.gameId;
    if (!gameId) return;
    const session = sessions.get(gameId);
    if (!session) return;
    const color = getColorForSocket(session, socket.id);
    if (!color) return;
    if (session.game.isGameOver) return;
    if (session.drawOfferedBy !== null) return; // already a pending offer

    session.drawOfferedBy = color;
    pushViews(gameId);
  });

  socket.on('accept_draw', () => {
    const gameId = socket.data.gameId;
    if (!gameId) return;
    const session = sessions.get(gameId);
    if (!session) return;
    const color = getColorForSocket(session, socket.id);
    if (!color) return;
    if (session.game.isGameOver) return;

    const opponent: Color = color === 'white' ? 'black' : 'white';
    if (session.drawOfferedBy !== opponent) return; // can only accept an offer made by opponent

    if (session.timerHandle) { clearTimeout(session.timerHandle); session.timerHandle = null; }
    stopTimer(session, session.game.turn);
    session.drawOfferedBy = null;
    session.game.declareDraw();
    recordGameResult(gameId, session);
    pushViews(gameId);
  });

  socket.on('decline_draw', () => {
    const gameId = socket.data.gameId;
    if (!gameId) return;
    const session = sessions.get(gameId);
    if (!session) return;
    const color = getColorForSocket(session, socket.id);
    if (!color) return;

    const opponent: Color = color === 'white' ? 'black' : 'white';
    if (session.drawOfferedBy !== opponent) return;

    session.drawOfferedBy = null;
    pushViews(gameId);
  });

  // ── Reset ─────────────────────────────────────────────────────────────────

  socket.on('reset_game', async () => {
    const gameId = socket.data.gameId;
    if (!gameId) return;
    const session = sessions.get(gameId);
    if (!session) return;

    if (session.timerHandle) { clearTimeout(session.timerHandle); session.timerHandle = null; }
    if (session.botMoveHandle) { clearTimeout(session.botMoveHandle); session.botMoveHandle = null; }

    // Refresh ELOs from DB so the next game uses up-to-date ratings
    if (session.uuids.white) session.elos.white = (await db.getOrCreatePlayer(session.uuids.white)).elo;
    if (session.uuids.black) session.elos.black = (await db.getOrCreatePlayer(session.uuids.black)).elo;

    session.timeRemaining = { white: session.timeControl * 1000, black: session.timeControl * 1000 };
    session.turnStartTime = null;
    session.eloRecorded = false;
    session.drawOfferedBy = null;
    session.game = new SpecterChessGame();

    startTimer(gameId, session);
    pushViews(gameId);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastStats();
    const gameId = socket.data.gameId;
    if (!gameId) return;
    const session = sessions.get(gameId);
    if (!session) return;

    const color = getColorForSocket(session, socket.id);
    if (!color) return;

    if (openGames.has(gameId)) {
      if (session.timerHandle) clearTimeout(session.timerHandle);
      openGames.delete(gameId);
      sessions.delete(gameId);
      broadcastOpenGames();
      return;
    }

    if (session.timerHandle) { clearTimeout(session.timerHandle); session.timerHandle = null; }
    if (session.botMoveHandle) { clearTimeout(session.botMoveHandle); session.botMoveHandle = null; }

    // For bot games just clean up — no opponent to notify
    if (session.botDifficulty !== null) {
      sessions.delete(gameId);
      return;
    }

    const opponent: Color = color === 'white' ? 'black' : 'white';
    const opponentSocketId = session.sockets[opponent];
    if (opponentSocketId) io.to(opponentSocketId).emit('opponent_disconnected');

    delete session.sockets[color];
    if (!session.sockets.white && !session.sockets.black) sessions.delete(gameId);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  await initDb();
  await initGameDb();
  httpServer.listen(PORT, () => {
    console.log(`Specter Chess server running on http://localhost:${PORT}`);
  });
}

main().catch(console.error);
