import { Chess } from 'chess.js';
import type { BotDifficulty, Move, Square } from '@specter-chess/shared';

// ─── Piece values ─────────────────────────────────────────────────────────────

const PIECE_VALUE: Record<string, number> = {
  p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000,
};

const PROMOTION_ORDER: Record<string, number> = { q: 4, r: 3, b: 2, n: 1 };

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
): number {
  if (depth === 0 || chess.isGameOver()) {
    return evaluate(chess, botColor);
  }

  // Prefer queen promotions to avoid evaluating weak promotions deeply
  const moves = chess.moves({ verbose: true })
    .sort((a, b) => (PROMOTION_ORDER[b.promotion ?? ''] ?? 0) - (PROMOTION_ORDER[a.promotion ?? ''] ?? 0));

  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      chess.move(m);
      best = Math.max(best, minimax(chess, depth - 1, alpha, beta, false, botColor));
      chess.undo();
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      chess.move(m);
      best = Math.min(best, minimax(chess, depth - 1, alpha, beta, true, botColor));
      chess.undo();
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a square the bot should spy on: a square the human's pieces could
 * plausibly have moved to (reachable from their snapshot positions) that appears
 * empty in the bot's perspective FEN — meaning the bot doesn't know if it's
 * actually occupied or not.
 */
export function getBotSpyglassTarget(perspectiveFen: string): Square | null {
  const perspective = new Chess(perspectiveFen);

  // Flip the turn to white so we can compute white's legal moves from their
  // snapshot positions. skipValidation handles cases where the resulting FEN
  // would be rejected (e.g. a king appears in check due to stale positions).
  const parts = perspectiveFen.split(' ');
  parts[1] = 'w';
  parts[3] = '-'; // clear en passant target
  const analysisFen = parts.join(' ');

  const analysis = new Chess();
  let whiteMoves: ReturnType<typeof analysis.moves>;
  try {
    analysis.load(analysisFen, { skipValidation: true });
    whiteMoves = analysis.moves({ verbose: true });
  } catch {
    return null;
  }

  // Collect destination squares that appear empty in the bot's perspective —
  // these are squares the human could have moved to but the bot can't see.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const m of whiteMoves) {
    if (seen.has(m.to)) continue;
    seen.add(m.to);
    if (!perspective.get(m.to as Parameters<typeof perspective.get>[0])) {
      candidates.push(m.to);
    }
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)] as Square;
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

  // Hard: sort by minimax score, best first
  const scored = moves.map(m => {
    chess.move(m);
    const score = minimax(chess, 2, -Infinity, Infinity, false, botColor);
    chess.undo();
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => toMove(s.m));
}

export function getBotDelay(difficulty: BotDifficulty): number {
  switch (difficulty) {
    case 'easy':   return 600 + Math.random() * 900;
    case 'medium': return 450 + Math.random() * 600;
    case 'hard':   return 250 + Math.random() * 350;
  }
}
