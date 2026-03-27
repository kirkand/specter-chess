import { Chess } from 'chess.js';
import type { BotDifficulty, Move, Square } from '@specter-chess/shared';

// ─── Piece values ─────────────────────────────────────────────────────────────

const PIECE_VALUE: Record<string, number> = {
  p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000,
};

const PROMOTION_ORDER: Record<string, number> = { q: 4, r: 3, b: 2, n: 1 };

const HARD_TIME_LIMIT_MS = 7000;
const HARD_MAX_DEPTH = 6;

// ─── Search context ────────────────────────────────────────────────────────────

interface SearchContext {
  deadline: number;
  timedOut: boolean;
}

// ─── Move ordering ─────────────────────────────────────────────────────────────
// Captures (MVV-LVA: most valuable victim, least valuable attacker) first,
// then queen promotions, then quiet moves. Better ordering → more alpha-beta cutoffs.

function orderMoves<T extends { piece: string; captured?: string; promotion?: string }>(moves: T[]): T[] {
  return [...moves].sort((a, b) => {
    const promA = PROMOTION_ORDER[a.promotion ?? ''] ?? 0;
    const promB = PROMOTION_ORDER[b.promotion ?? ''] ?? 0;
    if (promB !== promA) return promB - promA;
    const mvvLva = (m: T) =>
      m.captured ? (PIECE_VALUE[m.captured] ?? 0) - (PIECE_VALUE[m.piece] ?? 0) / 10 : -1000;
    return mvvLva(b) - mvvLva(a);
  });
}

function toMove(m: { from: string; to: string; promotion?: string }): Move {
  const promotionMap: Record<string, Move['promotion']> = {
    q: 'queen', r: 'rook', b: 'bishop', n: 'knight',
  };
  return {
    from: m.from,
    to: m.to,
    promotion: m.promotion ? promotionMap[m.promotion] : undefined,
  };
}

// ─── Piece-square tables ──────────────────────────────────────────────────────
// Indexed [rankIdx * 8 + fileIdx] where rankIdx 0 = rank 8, 7 = rank 1 (chess.js board order).
// For black pieces the table is mirrored: index = (7 - rankIdx) * 8 + fileIdx.

/* eslint-disable */
const PST: Record<string, number[]> = {
  p: [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};
/* eslint-enable */

// ─── Evaluation ───────────────────────────────────────────────────────────────

function evaluate(chess: Chess, botColor: 'w' | 'b'): number {
  if (chess.isCheckmate()) {
    return chess.turn() === botColor ? -99999 : 99999;
  }
  if (chess.isDraw()) return 0;

  let score = 0;
  const board = chess.board();
  for (let rankIdx = 0; rankIdx < 8; rankIdx++) {
    for (let fileIdx = 0; fileIdx < 8; fileIdx++) {
      const cell = board[rankIdx][fileIdx];
      if (!cell) continue;
      const material = PIECE_VALUE[cell.type] ?? 0;
      const pst = PST[cell.type];
      const pstIdx = cell.color === 'w'
        ? rankIdx * 8 + fileIdx
        : (7 - rankIdx) * 8 + fileIdx;
      const positional = pst ? (pst[pstIdx] ?? 0) : 0;
      const total = material + positional;
      score += cell.color === botColor ? total : -total;
    }
  }
  return score;
}

// ─── Minimax with alpha-beta pruning ──────────────────────────────────────────

function minimax(
  chess: Chess,
  depth: number,
  alpha: number,
  beta: number,
  maximizing: boolean,
  botColor: 'w' | 'b',
  ctx: SearchContext,
): number {
  if (ctx.timedOut || Date.now() >= ctx.deadline) {
    ctx.timedOut = true;
    return 0;
  }
  if (depth === 0 || chess.isGameOver()) {
    return evaluate(chess, botColor);
  }

  const moves = orderMoves(chess.moves({ verbose: true }));

  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      chess.move(m);
      best = Math.max(best, minimax(chess, depth - 1, alpha, beta, false, botColor, ctx));
      chess.undo();
      if (ctx.timedOut) return best;
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      chess.move(m);
      best = Math.min(best, minimax(chess, depth - 1, alpha, beta, true, botColor, ctx));
      chess.undo();
      if (ctx.timedOut) return best;
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the square the bot should spy on.
 *
 * Strategy: simulate the human's decision-making by scoring all their legal
 * moves from their own perspective FEN (true white pieces + stale black pieces).
 * The destination of the human's predicted best move is the most valuable square
 * to reveal — that's where a hidden black piece is most likely to interfere.
 */
export function getBotSpyglassTarget(
  humanPerspectiveFen: string,
  botPerspectiveFen: string,
  recentSquares: string[] = [],
): Square | null {
  const chess = new Chess();
  try {
    chess.load(humanPerspectiveFen, { skipValidation: true });
  } catch {
    return null;
  }

  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;

  // Squares the bot already knows about (occupied in its own perspective) —
  // spying there reveals nothing new. Bot's own pieces (black) are already
  // included in the perspective FEN, so no separate true-board pass needed.
  const botPerspective = new Chess();
  try {
    botPerspective.load(botPerspectiveFen, { skipValidation: true });
  } catch {
    return null;
  }
  const knownSquares = new Set<string>();
  for (const row of botPerspective.board()) {
    for (const cell of row) {
      if (cell) knownSquares.add(cell.square);
    }
  }

  const recentSet = new Set(recentSquares);

  // Score human moves, keeping only those whose destination is uncertain to the
  // bot and hasn't been spied on in the last 3 turns.
  const scored = moves
    .filter(m => !knownSquares.has(m.to) && !recentSet.has(m.to))
    .map(m => {
      chess.move(m);
      const score = evaluate(chess, 'w');
      chess.undo();
      return { m, score };
    });

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  // Pick randomly from the top 3 candidates to avoid always choosing the same square.
  const pool = scored.slice(0, 3);
  return pool[Math.floor(Math.random() * pool.length)].m.to as Square;
}

/**
 * Returns all bot moves in priority order (best first).
 * The caller should try each in sequence, stopping at the first one the
 * server accepts against the true board state.
 */
export function getBotMoveCandidates(fen: string, difficulty: BotDifficulty, botColor: 'w' | 'b'): Move[] {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return [];

  // Easy: random order
  if (difficulty === 'easy') {
    const shuffled = [...moves];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.map(toMove);
  }

  // Medium: sort by immediate material score, best first
  if (difficulty === 'medium') {
    const scored = moves.map(m => {
      chess.move(m);
      const score = evaluate(chess, botColor);
      chess.undo();
      return { m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => toMove(s.m));
  }

  // Hard: iterative deepening minimax with 7-second time limit.
  // Each completed depth improves move ordering for the next, maximising
  // alpha-beta pruning efficiency. The best fully-searched result is kept.
  const ctx: SearchContext = { deadline: Date.now() + HARD_TIME_LIMIT_MS, timedOut: false };
  let orderedMoves = orderMoves(moves);
  let bestScored = orderedMoves.map(m => ({ m, score: 0 }));

  for (let depth = 1; depth <= HARD_MAX_DEPTH; depth++) {
    if (Date.now() >= ctx.deadline) break;
    ctx.timedOut = false;

    const scored = orderedMoves.map(m => {
      chess.move(m);
      const score = minimax(chess, depth - 1, -Infinity, Infinity, false, botColor, ctx);
      chess.undo();
      return { m, score };
    });

    if (!ctx.timedOut) {
      scored.sort((a, b) => b.score - a.score);
      bestScored = scored;
      // Re-order for next iteration so best moves are searched first
      const scoreMap = new Map(scored.map(s => [s.m, s.score]));
      orderedMoves = [...orderedMoves].sort((a, b) => (scoreMap.get(b) ?? 0) - (scoreMap.get(a) ?? 0));
    } else {
      break;
    }
  }

  return bestScored.map(s => toMove(s.m));
}

