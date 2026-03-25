import { Chess, type Color as ChessColor, type PieceSymbol, type Square as ChessSquare } from 'chess.js';
import type {
  Color,
  Piece,
  PieceType,
  PiecePosition,
  Move,
  CorePlayerView,
  SpyglassResult,
  Square,
} from './types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fromChessColor(c: ChessColor): Color {
  return c === 'w' ? 'white' : 'black';
}

function toChessColor(c: Color): ChessColor {
  return c === 'white' ? 'w' : 'b';
}

const PIECE_TYPE_MAP: Record<PieceSymbol, PieceType> = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
};

const PIECE_SYMBOL_MAP: Record<PieceType, PieceSymbol> = {
  king: 'k',
  queen: 'q',
  rook: 'r',
  bishop: 'b',
  knight: 'n',
  pawn: 'p',
};

function fromChessPiece(p: { type: PieceSymbol; color: ChessColor }): Piece {
  return { type: PIECE_TYPE_MAP[p.type], color: fromChessColor(p.color) };
}

function getAllPieces(chess: Chess): PiecePosition[] {
  const positions: PiecePosition[] = [];
  const board = chess.board();
  for (const row of board) {
    for (const cell of row) {
      if (cell) {
        positions.push({ square: cell.square, piece: fromChessPiece(cell) });
      }
    }
  }
  return positions;
}

function getPiecesForColor(chess: Chess, color: Color): PiecePosition[] {
  return getAllPieces(chess).filter(p => p.piece.color === color);
}

const START_COUNTS: Partial<Record<PieceSymbol, number>> = { p: 8, r: 2, n: 2, b: 2, q: 1, k: 1 };

function getCapturedPieces(chess: Chess, capturedColor: ChessColor): Piece[] {
  const current: Partial<Record<PieceSymbol, number>> = {};
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.color === capturedColor) {
        current[cell.type] = (current[cell.type] ?? 0) + 1;
      }
    }
  }
  const captured: Piece[] = [];
  for (const [t, startCount] of Object.entries(START_COUNTS)) {
    const type = t as PieceSymbol;
    const diff = startCount! - (current[type] ?? 0);
    for (let i = 0; i < diff; i++) {
      captured.push({ type: PIECE_TYPE_MAP[type], color: fromChessColor(capturedColor) });
    }
  }
  return captured;
}

// ─── SpecterChessGame ─────────────────────────────────────────────────────────

/**
 * Authoritative server-side game state.
 * Maintains the true board (via chess.js) plus each player's filtered view.
 */
export class SpecterChessGame {
  private chess: Chess;

  /**
   * Each player's "stale snapshot" of their opponent.
   * Updated to opponent's current positions AT THE MOMENT the opponent begins
   * their turn (before they execute their move). This means the viewing player
   * always sees the opponent as they were before the opponent's latest move.
   */
  private opponentSnapshot: Record<Color, PiecePosition[]>;

  /**
   * Spyglass-confirmed positions per player (what they revealed about opponent).
   * Keyed by the confirming player's color.
   */
  private confirmedPositions: Record<Color, Map<Square, Piece>>;

  /** Whether each player has used their spyglass this turn */
  private spyglassUsed: Record<Color, boolean>;

  /** Spyglass blocked for one turn because this player's own piece was just captured */
  private spyglassDisabled: Record<Color, boolean>;

  /** The most recent move made by each color (used to clean up stale snapshot on spyglass) */
  private lastMove: Record<Color, { from: Square; to: Square; rookFrom?: Square; rookTo?: Square } | null>;

  /** Whose turn it is */
  private currentTurn: Color;

  /** Set when a player loses on time or resigns; overrides chess.js game-over state */
  private timeoutLoser: Color | null = null;

  /** Set when both players agree to a draw */
  private drawAccepted: boolean = false;

  constructor() {
    this.chess = new Chess();
    const startingPositions = getAllPieces(this.chess);

    // At game start, both players see the full starting position.
    // White's snapshot of Black (opponent) = starting Black positions.
    // Black's snapshot of White (opponent) = starting White positions.
    this.opponentSnapshot = {
      white: startingPositions.filter(p => p.piece.color === 'black'),
      black: startingPositions.filter(p => p.piece.color === 'white'),
    };

    this.confirmedPositions = {
      white: new Map(),
      black: new Map(),
    };

    this.spyglassUsed = { white: false, black: false };
    this.spyglassDisabled = { white: false, black: false };
    this.lastMove = { white: null, black: null };
    this.currentTurn = 'white';
  }

  get turn(): Color {
    return this.currentTurn;
  }

  get isGameOver(): boolean {
    return this.chess.isGameOver() || this.timeoutLoser !== null || this.drawAccepted;
  }

  get winner(): Color | null {
    if (this.drawAccepted) return null;
    if (this.timeoutLoser !== null) return this.timeoutLoser === 'white' ? 'black' : 'white';
    if (!this.chess.isCheckmate()) return null;
    return this.currentTurn === 'white' ? 'black' : 'white';
  }

  declareTimeout(loser: Color): void {
    this.timeoutLoser = loser;
  }

  declareDraw(): void {
    this.drawAccepted = true;
  }

  getFen(): string {
    return this.chess.fen();
  }

  /**
   * Returns a FEN from the bot's (black's) perspective:
   * black pieces at their true positions, white pieces at their stale snapshot
   * positions (what black last saw before white's most recent move).
   * Falls back to the true FEN if the synthetic position is rejected by chess.js.
   */
  getBotPerspectiveFen(): string {
    const pieceMap: Record<string, string> = {};

    // True black piece positions (lowercase FEN chars)
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (cell && cell.color === 'b') {
          pieceMap[cell.square] = cell.type;
        }
      }
    }

    // White pieces at stale snapshot positions (uppercase FEN chars)
    // Skip any square already occupied by a black piece
    for (const { square, piece } of this.opponentSnapshot['black']) {
      if (!pieceMap[square]) {
        pieceMap[square] = PIECE_SYMBOL_MAP[piece.type].toUpperCase();
      }
    }

    // Override/add confirmed white piece positions (revealed by capture or spyglass).
    // These are the true current positions the bot has observed, so they take
    // precedence over the stale snapshot.
    for (const [square, piece] of this.confirmedPositions['black']) {
      if (piece.color === 'white' && !pieceMap[square]) {
        pieceMap[square] = PIECE_SYMBOL_MAP[piece.type].toUpperCase();
      }
    }

    // Build piece placement string (rank 8 down to rank 1)
    let placement = '';
    for (let rank = 8; rank >= 1; rank--) {
      let empty = 0;
      for (const file of 'abcdefgh') {
        const sq = `${file}${rank}`;
        const p = pieceMap[sq];
        if (p) {
          if (empty > 0) { placement += empty; empty = 0; }
          placement += p;
        } else {
          empty++;
        }
      }
      if (empty > 0) placement += empty;
      if (rank > 1) placement += '/';
    }

    // Approximate castling rights from piece positions
    const whiteSnap = this.opponentSnapshot['black'];
    const wKingE1  = whiteSnap.some(p => p.square === 'e1' && p.piece.type === 'king');
    const wRookH1  = whiteSnap.some(p => p.square === 'h1' && p.piece.type === 'rook');
    const wRookA1  = whiteSnap.some(p => p.square === 'a1' && p.piece.type === 'rook');
    const bKingE8  = pieceMap['e8'] === 'k';
    const bRookH8  = pieceMap['h8'] === 'r';
    const bRookA8  = pieceMap['a8'] === 'r';

    let castling = '';
    if (wKingE1 && wRookH1) castling += 'K';
    if (wKingE1 && wRookA1) castling += 'Q';
    if (bKingE8  && bRookH8)  castling += 'k';
    if (bKingE8  && bRookA8)  castling += 'q';
    if (!castling) castling = '-';

    const fen = `${placement} b ${castling} - 0 1`;

    // Validate — chess.js rejects positions where the non-moving side is in check,
    // has missing kings, pawns on back ranks, etc. Fall back to true FEN if invalid.
    try {
      new Chess(fen);
      return fen;
    } catch {
      return this.chess.fen();
    }
  }

  /**
   * Returns a FEN from the human's (white's) perspective:
   * white pieces at their true positions, black pieces at their stale snapshot
   * positions (what white last saw before black's most recent move).
   * Falls back to the true FEN if the synthetic position is rejected by chess.js.
   */
  getHumanPerspectiveFen(): string {
    const pieceMap: Record<string, string> = {};

    // True white piece positions (uppercase FEN chars)
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (cell && cell.color === 'w') {
          pieceMap[cell.square] = cell.type.toUpperCase();
        }
      }
    }

    // Black pieces at stale snapshot positions (lowercase FEN chars)
    // Skip any square already occupied by a white piece
    for (const { square, piece } of this.opponentSnapshot['white']) {
      if (!pieceMap[square]) {
        pieceMap[square] = PIECE_SYMBOL_MAP[piece.type];
      }
    }

    // Override/add confirmed black piece positions (revealed by capture or spyglass)
    for (const [square, piece] of this.confirmedPositions['white']) {
      if (piece.color === 'black' && !pieceMap[square]) {
        pieceMap[square] = PIECE_SYMBOL_MAP[piece.type];
      }
    }

    // Build piece placement string (rank 8 down to rank 1)
    let placement = '';
    for (let rank = 8; rank >= 1; rank--) {
      let empty = 0;
      for (const file of 'abcdefgh') {
        const sq = `${file}${rank}`;
        const p = pieceMap[sq];
        if (p) {
          if (empty > 0) { placement += empty; empty = 0; }
          placement += p;
        } else {
          empty++;
        }
      }
      if (empty > 0) placement += empty;
      if (rank > 1) placement += '/';
    }

    // Approximate castling rights from piece positions
    const blackSnap = this.opponentSnapshot['white'];
    const bKingE8 = blackSnap.some(p => p.square === 'e8' && p.piece.type === 'king');
    const bRookH8 = blackSnap.some(p => p.square === 'h8' && p.piece.type === 'rook');
    const bRookA8 = blackSnap.some(p => p.square === 'a8' && p.piece.type === 'rook');
    const wKingE1 = pieceMap['e1'] === 'K';
    const wRookH1 = pieceMap['h1'] === 'R';
    const wRookA1 = pieceMap['a1'] === 'R';

    let castling = '';
    if (wKingE1 && wRookH1) castling += 'K';
    if (wKingE1 && wRookA1) castling += 'Q';
    if (bKingE8 && bRookH8) castling += 'k';
    if (bKingE8 && bRookA8) castling += 'q';
    if (!castling) castling = '-';

    const fen = `${placement} w ${castling} - 0 1`;

    try {
      new Chess(fen);
      return fen;
    } catch {
      return this.chess.fen();
    }
  }

  /**
   * Attempt a move for the given player.
   * Returns true if the move was valid and executed, false otherwise.
   */
  attemptMove(color: Color, move: Move): boolean {
    if (this.currentTurn !== color) return false;
    if (this.isGameOver) return false;

    // Snapshot the moving player's current positions BEFORE they move.
    // This becomes what the opponent will see after this turn.
    const preMovePieces = getPiecesForColor(this.chess, color);

    const promotion = move.promotion ? PIECE_SYMBOL_MAP[move.promotion] : undefined;
    let result;
    try {
      result = this.chess.move({
        from: move.from as ChessSquare,
        to: move.to as ChessSquare,
        promotion,
      });
    } catch {
      return false;
    }
    if (!result) return false;

    // Clear this player's capture-block now that they've completed their move
    this.spyglassDisabled[color] = false;

    // Update opponent's snapshot of the moving player to their pre-move positions.
    const opponent: Color = color === 'white' ? 'black' : 'white';
    this.opponentSnapshot[opponent] = preMovePieces;

    // Invalidate any confirmed positions the opponent had for pieces that moved.
    // The moving player moved one piece (from result.from to result.to).
    // Also handle captures: if opponent had the captured piece confirmed, remove it.
    const movedFrom = result.from as Square;
    const movedTo = result.to as Square;

    // If opponent had a confirmed piece at the square the moving player came FROM
    // (shouldn't happen since that's the moving player's own piece, but be safe)
    // More importantly: if the moving player captured an opponent piece, and
    // the viewing player (opponent of moving player) had that piece confirmed,
    // we need to remove that confirmation.
    // Actually: confirmedPositions[white] = what white confirmed about black.
    // If black moved and captured a piece that white had confirmed, clear it.
    // result.captured means a piece was captured at movedTo.
    if (result.captured) {
      // The opponent just lost a piece — disable their spyglass for their next turn
      this.spyglassDisabled[opponent] = true;

      // Clear the capturing player's confirmed info about the now-captured piece
      this.confirmedPositions[color].delete(movedTo);

      // Reveal the capturing piece's true position to the player who was captured.
      // Their piece just disappeared — show them what took it and where it landed.
      const capturingPiece: Piece = {
        type: PIECE_TYPE_MAP[result.piece],
        color: fromChessColor(result.color),
      };
      this.confirmedPositions[opponent].set(movedTo, capturingPiece);

      // Remove the capturing piece from the captured player's snapshot at its old square
      // to avoid showing it at both the old (stale) and new (confirmed) positions.
      this.opponentSnapshot[opponent] = this.opponentSnapshot[opponent].filter(
        p => p.square !== movedFrom
      );

      // Remove the captured piece from the capturing player's snapshot.
      // If the captured piece moved to movedTo last turn, its snapshot square is lastMove.from.
      // Otherwise it was stationary and appears in the snapshot at movedTo itself.
      const capturedSnapshotSquare = this.lastMove[opponent]?.to === movedTo
        ? this.lastMove[opponent]!.from
        : movedTo;
      this.opponentSnapshot[color] = this.opponentSnapshot[color].filter(
        p => p.square !== capturedSnapshotSquare
      );
      // Also clear any confirmed position the capturing player had for this piece
      this.confirmedPositions[color].delete(capturedSnapshotSquare);
    }

    // The moving player's own confirmed positions about opponent are unaffected by their own move.
    // But if the opponent had confirmed the moving player's piece at movedFrom, that is now stale.
    // confirmedPositions[opponent] tracks what the opponent knows about the moving player.
    // The moving player moved from movedFrom — opponent's confirmed info about that square is stale.
    this.confirmedPositions[opponent].delete(movedFrom);
    // Also clear movedTo in case opponent had confirmed something there (already handled by capture above,
    // but en passant capture square differs from destination)
    if (result.flags.includes('e')) {
      // En passant: captured pawn is on the same rank as origin, not movedTo
      const epCaptureSquare = `${movedTo[0]}${movedFrom[1]}` as Square;
      this.confirmedPositions[color].delete(epCaptureSquare);
    }

    // For castling, record the rook's from/to so spyglass can reveal both pieces.
    let rookFrom: Square | undefined;
    let rookTo: Square | undefined;
    if (result.flags.includes('k') || result.flags.includes('q')) {
      const rank = movedFrom[1]; // '1' or '8'
      if (result.flags.includes('k')) {
        rookFrom = `h${rank}` as Square;
        rookTo   = `f${rank}` as Square;
      } else {
        rookFrom = `a${rank}` as Square;
        rookTo   = `d${rank}` as Square;
      }
    }
    this.lastMove[color] = { from: movedFrom, to: movedTo, rookFrom, rookTo };

    // Reset spyglass for the player whose turn is starting next
    this.spyglassUsed[opponent] = false;
    this.currentTurn = opponent;

    return true;
  }

  /**
   * Use the spyglass for the given player on the given square.
   * Can only be used once per turn, before moving.
   */
  useSpyglass(color: Color, square: Square): SpyglassResult | null {
    if (this.currentTurn !== color) return null;
    if (this.spyglassUsed[color]) return null;
    if (this.spyglassDisabled[color]) return null;

    this.spyglassUsed[color] = true;

    const piece = this.chess.get(square as ChessSquare);
    const result: SpyglassResult = {
      square,
      piece: piece ? fromChessPiece(piece) : null,
    };

    // If an opponent piece was found, add to confirmed positions
    if (piece && fromChessColor(piece.color) !== color) {
      const confirmedPiece = fromChessPiece(piece);
      this.confirmedPositions[color].set(square, confirmedPiece);

      const opponentColor: Color = color === 'white' ? 'black' : 'white';
      const opponentLastMove = this.lastMove[opponentColor];

      if (opponentLastMove) {
        const hitKing = opponentLastMove.to === square;
        const hitRook = opponentLastMove.rookTo !== undefined && opponentLastMove.rookTo === square;

        if ((hitKing || hitRook) && opponentLastMove.rookTo !== undefined) {
          // Castling: reveal both king and rook at their true positions, remove both stale entries.
          const kingSquare = opponentLastMove.to;
          const rookSquare = opponentLastMove.rookTo;
          const kingPiece = this.chess.get(kingSquare as ChessSquare);
          const rookPiece = this.chess.get(rookSquare as ChessSquare);
          if (kingPiece) this.confirmedPositions[color].set(kingSquare, fromChessPiece(kingPiece));
          if (rookPiece) this.confirmedPositions[color].set(rookSquare, fromChessPiece(rookPiece));
          const staleSquares = new Set([opponentLastMove.from, opponentLastMove.rookFrom!]);
          this.opponentSnapshot[color] = this.opponentSnapshot[color].filter(
            p => !staleSquares.has(p.square)
          );
        } else if (hitKing) {
          // Normal move: remove the piece's old snapshot position.
          this.opponentSnapshot[color] = this.opponentSnapshot[color].filter(
            p => p.square !== opponentLastMove.from
          );
        }
      }
    } else {
      // Square is empty or own piece — clear any stale confirmed entry for this square
      this.confirmedPositions[color].delete(square);
    }

    return result;
  }

  /**
   * Build the filtered view for the given player.
   */
  getPlayerView(color: Color): CorePlayerView {
    const opponent: Color = color === 'white' ? 'black' : 'white';

    const confirmedArr: PiecePosition[] = [];
    this.confirmedPositions[color].forEach((piece, square) => {
      confirmedArr.push({ square, piece });
    });

    return {
      color,
      ownPieces: getPiecesForColor(this.chess, color),
      opponentSnapshot: this.opponentSnapshot[color],
      confirmedOpponentPositions: confirmedArr,
      isMyTurn: this.currentTurn === color,
      inCheck: this.currentTurn === color && this.chess.inCheck(),
      spyglassUsedThisTurn: this.spyglassUsed[color] || this.spyglassDisabled[color],
      plyCount: this.chess.history().length,
      capturedByMe: getCapturedPieces(this.chess, toChessColor(opponent)),
      capturedByOpponent: getCapturedPieces(this.chess, toChessColor(color)),
      gameOver: this.isGameOver,
      winner: this.winner,
    };
  }

  /**
   * Returns the squares the opponent had confirmed at a given position
   * that are now invalidated (piece moved away). Used to notify the opponent.
   * Call this BEFORE attemptMove to capture the pre-move confirmed squares.
   */
  getConfirmedSquaresForColor(viewingPlayer: Color): Square[] {
    return Array.from(this.confirmedPositions[viewingPlayer].keys());
  }
}
