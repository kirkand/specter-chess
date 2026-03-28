import { useEffect, useMemo, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { CHAT_EMOTES } from '@specter-chess/shared';
import type { PlayerView, Color, Move, Square, SpyglassResult, Piece, ChatEmote } from '@specter-chess/shared';
import { isSoundEnabled, setSoundEnabled } from './sounds';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_BOARD_SIZE = 520;
const ANIM_DURATION = 650;
const TRAIL_DURATION = 350; // flame streak lives slightly longer than the 200 ms slide

let nextAnimId = 0;

function getBoardSize() {
  return Math.min(MAX_BOARD_SIZE, window.innerWidth - 16);
}

function squareToPixel(square: Square, orientation: Color, squareSize: number): { top: number; left: number } {
  const file = square.charCodeAt(0) - 97; // 'a'=0 … 'h'=7
  const rank = parseInt(square[1]) - 1;   // '1'=0 … '8'=7
  return orientation === 'white'
    ? { left: file * squareSize, top: (7 - rank) * squareSize }
    : { left: (7 - file) * squareSize, top: rank * squareSize };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PIECE_SYMBOL: Record<string, string> = {
  'white-king': 'wK', 'white-queen': 'wQ', 'white-rook': 'wR',
  'white-bishop': 'wB', 'white-knight': 'wN', 'white-pawn': 'wP',
  'black-king': 'bK', 'black-queen': 'bQ', 'black-rook': 'bR',
  'black-bishop': 'bB', 'black-knight': 'bN', 'black-pawn': 'bP',
};

function pieceToFen(piece: Piece): string {
  return PIECE_SYMBOL[`${piece.color}-${piece.type}`] ?? '';
}

/**
 * Build a custom position object for react-chessboard from a PlayerView.
 * Own pieces are shown normally. Opponent pieces are shown at their
 * stale snapshot positions, with confirmed positions overriding the snapshot.
 * Hidden pieces (those in neither snapshot nor confirmed) are not shown.
 *
 * We render hidden opponent pieces with a "ghost" styling handled separately.
 */
function buildPosition(view: PlayerView): Record<string, string> {
  const pos: Record<string, string> = {};

  // Own pieces
  for (const { square, piece } of view.ownPieces) {
    pos[square] = pieceToFen(piece);
  }

  // Opponent: start with snapshot, then override with confirmed
  const opponentSquares = new Map<Square, Piece>();
  for (const { square, piece } of view.opponentSnapshot) {
    opponentSquares.set(square, piece);
  }
  for (const { square, piece } of view.confirmedOpponentPositions) {
    // Remove the snapshot entry that was at this square (if any) to avoid duplicates
    // Also: a confirmed piece at a new square means their old snapshot square is cleared
    opponentSquares.set(square, piece);
  }

  // Remove snapshot positions for pieces that have confirmed positions elsewhere.
  // Build set of confirmed squares for fast lookup.
  const confirmedSquares = new Set(view.confirmedOpponentPositions.map(p => p.square));
  // For any snapshot piece whose square matches a confirmed square, skip it (already added).
  // For snapshot pieces whose square is NOT confirmed, include them as-is (stale/ghost).
  for (const { square, piece } of view.opponentSnapshot) {
    if (!confirmedSquares.has(square)) {
      opponentSquares.set(square, piece);
    }
  }

  for (const [square, piece] of opponentSquares.entries()) {
    // Don't overwrite own piece (shouldn't happen, but be safe)
    if (!pos[square]) {
      pos[square] = pieceToFen(piece);
    }
  }

  return pos;
}

// ─── Captured pieces ─────────────────────────────────────────────────────────

const PIECE_DISPLAY_ORDER: string[] = ['queen', 'rook', 'bishop', 'knight', 'pawn'];

const UNICODE_PIECE: Record<string, string> = {
  'white-queen': '♕', 'white-rook': '♖', 'white-bishop': '♗', 'white-knight': '♘', 'white-pawn': '♙',
  'black-queen': '♛', 'black-rook': '♜', 'black-bishop': '♝', 'black-knight': '♞', 'black-pawn': '♟',
};

function CapturedPieces({ pieces }: { pieces: Piece[] }) {
  const sorted = PIECE_DISPLAY_ORDER.flatMap(type => pieces.filter(p => p.type === type));
  if (sorted.length === 0) return <div style={{ minHeight: '1.8rem' }} />;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1px', minHeight: '1.8rem', alignItems: 'center' }}>
      {sorted.map((p, i) => (
        <span key={i} style={{ fontSize: '1.3rem', lineHeight: 1, filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.6))' }}>
          {UNICODE_PIECE[`${p.color}-${p.type}`]}
        </span>
      ))}
    </div>
  );
}

// ─── Clock ───────────────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function ClockDisplay({ timeMs, active, pulse }: { timeMs: number; active: boolean; pulse?: boolean }) {
  const low = timeMs > 0 && timeMs < 30_000;
  return (
    <div
      className={pulse ? 'clock-pulse' : undefined}
      style={{
        fontFamily: 'monospace',
        fontSize: '1.3rem',
        fontWeight: 'bold',
        padding: '0.2rem 0.65rem',
        borderRadius: '4px',
        background: active
          ? low ? 'rgba(220,50,50,0.25)' : 'rgba(255,255,255,0.12)'
          : 'rgba(255,255,255,0.04)',
        border: `1px solid ${active
          ? low ? 'rgba(220,50,50,0.7)' : 'rgba(255,255,255,0.25)'
          : 'rgba(255,255,255,0.08)'}`,
        color: active ? (low ? '#f77' : '#fff') : '#555',
        minWidth: '4.2rem',
        textAlign: 'center',
      }}
    >
      {formatTime(timeMs)}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

interface GameBoardProps {
  view: PlayerView;
  playerColor: Color;
  spyglassResult: SpyglassResult | null;
  opponentSpyglassSquare: string | null;
  lastRejected: boolean;
  inCheck: boolean;
  eloChange: number | null;
  onMove: (move: Move) => void;
  onSpyglass: (square: Square) => void;
  onResign: () => void;
  onOfferDraw: () => void;
  onAcceptDraw: () => void;
  onDeclineDraw: () => void;
  onReset: () => void;
  onReturnToLobby: () => void;
  myEmote: ChatEmote | null;
  opponentEmote: ChatEmote | null;
  onEmote: (text: ChatEmote) => void;
}

export function GameBoard({
  view,
  playerColor,
  spyglassResult,
  opponentSpyglassSquare,
  lastRejected,
  inCheck,
  eloChange,
  onMove,
  onSpyglass,
  onResign,
  onOfferDraw,
  onAcceptDraw,
  onDeclineDraw,
  onReset,
  onReturnToLobby,
  myEmote,
  opponentEmote,
  onEmote,
}: GameBoardProps) {
  const [boardSize, setBoardSize] = useState(getBoardSize);
  const squareSize = boardSize / 8;
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [animatingInSquares, setAnimatingInSquares] = useState<Set<Square>>(new Set());
  const [animatingOutPieces, setAnimatingOutPieces] = useState<
    { id: number; square: Square; piece: Piece }[]
  >([]);
  const [showOutcome, setShowOutcome] = useState(false);
  // Two-step capture animation: while set, the capturing piece is shown at the
  // intermediate square (where it actually moved FROM) rather than the confirmed
  // capture square, so react-chessboard slides stale-pos → fromSquare first.
  // capturedPieceFen keeps the captured own piece visible in the position during phase 1.
  const [captureAnim, setCaptureAnim] = useState<{
    confirmedSquare: Square;
    fromSquare: Square;
    capturedPieceFen: string | null;
  } | null>(null);
  // Fade-out overlay for the captured own piece (shown while the attacker slides in).
  const [capturedOverlay, setCapturedOverlay] = useState<{ square: Square; piece: Piece } | null>(null);
  // Flame trail segments rendered as SVG overlays during capture slides.
  const [flameTrails, setFlameTrails] = useState<{ id: number; from: Square; to: Square }[]>([]);
  const [showEmotePicker, setShowEmotePicker] = useState(false);
  const [soundOn, setSoundOn] = useState(isSoundEnabled);
  const [clockPulse, setClockPulse] = useState(false);
  const prevIsMyTurnRef = useRef(view.isMyTurn);
  const prevViewRef = useRef<PlayerView>(view);
  const lastSubmittedMoveRef = useRef<Move | null>(null);

  useEffect(() => {
    function handleResize() { setBoardSize(getBoardSize()); }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Show outcome overlay briefly when the game ends
  useEffect(() => {
    if (!view.gameOver) return;
    setShowOutcome(true);
    const t = setTimeout(() => setShowOutcome(false), 3500);
    return () => clearTimeout(t);
  }, [view.gameOver]);

  // Detect spyglass animations: new confirmed position = animate in,
  // disappeared snapshot square = animate out.
  useEffect(() => {
    const prev = prevViewRef.current;
    prevViewRef.current = view;

    const prevConfirmed = new Set(prev.confirmedOpponentPositions.map(p => p.square));
    const newlyConfirmed = view.confirmedOpponentPositions.filter(p => !prevConfirmed.has(p.square));

    // Helper: add a flame trail segment that auto-removes after TRAIL_DURATION.
    function addTrail(from: Square, to: Square) {
      if (from === to) return;
      const tid = nextAnimId++;
      setFlameTrails(ts => [...ts, { id: tid, from, to }]);
      setTimeout(() => setFlameTrails(ts => ts.filter(t => t.id !== tid)), TRAIL_DURATION);
    }

    // Own capture: we just captured an opponent piece (capturedByMe grew).
    // Show a flame trail along the path of our own piece.
    if (view.capturedByMe.length > prev.capturedByMe.length && lastSubmittedMoveRef.current) {
      addTrail(lastSubmittedMoveRef.current.from, lastSubmittedMoveRef.current.to);
    }
    // Clear the stored move once our turn ends (turn flipped from ours to theirs).
    if (!view.isMyTurn && prev.isMyTurn) {
      lastSubmittedMoveRef.current = null;
    }

    // Only react when a new confirmation just arrived (spyglass was used)
    if (newlyConfirmed.length === 0) return;

    // A capture reveal (opponent captured our piece, automatically exposing the attacker)
    // always coincides with losing one of our own pieces. A spyglass use never does.
    const ownPieceLost = view.ownPieces.length < prev.ownPieces.length;
    if (ownPieceLost) {
      const fromSq = view.captureRevealFromSquare;
      const captureEntry = newlyConfirmed[0];

      // Find which of our pieces was taken (to show a fade-out overlay).
      const currSquares = new Set(view.ownPieces.map(p => p.square));
      const lostEntry = prev.ownPieces.find(p => !currSquares.has(p.square));

      // Find where the capturing piece was last shown (for the flame trail start).
      // We look for the piece that *disappeared* from the snapshot: as the snapshot
      // advances from S_{N-1} to S_N and the fromSquare is filtered out, the
      // capturing piece's old stale square drops out of view. This is unambiguous
      // even when multiple pieces share the same type (e.g., two pawns).
      const currSnapshotSquares = new Set(view.opponentSnapshot.map(p => p.square));
      const prevVisible = captureEntry ? (() => {
        const gone = prev.opponentSnapshot.find(
          p => !currSnapshotSquares.has(p.square) &&
               p.piece.type === captureEntry.piece.type &&
               p.piece.color === captureEntry.piece.color
        );
        if (gone) return gone.square;
        // Fallback: player had a confirmed position for this piece type/color
        return prev.confirmedOpponentPositions.find(
          p => p.piece.type === captureEntry.piece.type && p.piece.color === captureEntry.piece.color
        )?.square;
      })() : undefined;

      if (fromSq && captureEntry && fromSq !== captureEntry.square) {
        // Two-step animation:
        //   leg 1: stale-position → fromSquare  (slide, 200 ms) + flame trail
        //   pause: 200 ms
        //   leg 2: fromSquare → capture-square  (slide, 200 ms) + flame trail
        //
        // Keep the captured piece in the position during leg 1 + pause so it stays
        // visible. At leg 2 start, remove it from position and start the fade overlay.
        setCaptureAnim({
          confirmedSquare: captureEntry.square,
          fromSquare: fromSq,
          capturedPieceFen: lostEntry ? pieceToFen(lostEntry.piece) : null,
        });
        if (prevVisible) addTrail(prevVisible, fromSq); // leg 1 trail
        const t = setTimeout(() => {
          setCaptureAnim(null);
          addTrail(fromSq, captureEntry.square); // leg 2 trail
          if (lostEntry) {
            setCapturedOverlay({ square: captureEntry.square, piece: lostEntry.piece });
            setTimeout(() => setCapturedOverlay(null), 200);
          }
        }, 400); // 200 ms slide + 200 ms pause
        return () => clearTimeout(t);
      }

      // Single-step: the attacker slides directly from its stale position to the
      // capture square. Flame trail + fade out the captured piece simultaneously.
      if (prevVisible && captureEntry) addTrail(prevVisible, captureEntry.square);
      if (lostEntry) {
        setCapturedOverlay({ square: lostEntry.square, piece: lostEntry.piece });
        setTimeout(() => setCapturedOverlay(null), 200);
      }
      return;
    }

    const newSquares = newlyConfirmed.map(p => p.square);
    setAnimatingInSquares(s => new Set([...s, ...newSquares]));

    const currentSnapshotSquares = new Set(view.opponentSnapshot.map(p => p.square));
    const disappeared = prev.opponentSnapshot.filter(p => !currentSnapshotSquares.has(p.square));
    const newOut = disappeared.map(({ square, piece }) => ({ id: nextAnimId++, square, piece }));
    if (newOut.length) setAnimatingOutPieces(s => [...s, ...newOut]);

    const outIds = new Set(newOut.map(p => p.id));
    const t1 = setTimeout(() => {
      setAnimatingInSquares(s => { const n = new Set(s); newSquares.forEach(sq => n.delete(sq)); return n; });
    }, ANIM_DURATION);
    const t2 = newOut.length
      ? setTimeout(() => setAnimatingOutPieces(s => s.filter(p => !outIds.has(p.id))), ANIM_DURATION)
      : null;

    return () => { clearTimeout(t1); if (t2) clearTimeout(t2); };
  }, [view]);

  // ── Clocks ──────────────────────────────────────────────────────────────────
  const opponentColor: Color = playerColor === 'white' ? 'black' : 'white';
  const [displayedTime, setDisplayedTime] = useState(view.timeRemainingMs);
  const turnStartedAtRef = useRef<number>(Date.now());
  const serverTimeAtTurnStartRef = useRef(view.timeRemainingMs);

  // When server sends updated times, record the wall-clock start of this turn
  useEffect(() => {
    setDisplayedTime(view.timeRemainingMs);
    serverTimeAtTurnStartRef.current = view.timeRemainingMs;
    turnStartedAtRef.current = Date.now();
  }, [view.timeRemainingMs]);

  // Tick the active player's clock using wall-clock elapsed time
  useEffect(() => {
    if (view.gameOver) return;
    const activeColor: Color = view.isMyTurn ? playerColor : opponentColor;
    const interval = setInterval(() => {
      const elapsed = Date.now() - turnStartedAtRef.current;
      setDisplayedTime({
        ...serverTimeAtTurnStartRef.current,
        [activeColor]: Math.max(0, serverTimeAtTurnStartRef.current[activeColor] - elapsed),
      });
    }, 100);
    return () => clearInterval(interval);
  }, [view.isMyTurn, view.gameOver, playerColor, opponentColor]);

  useEffect(() => {
    if (view.isMyTurn && !prevIsMyTurnRef.current) {
      setClockPulse(true);
      setTimeout(() => setClockPulse(false), 1000);
    }
    prevIsMyTurnRef.current = view.isMyTurn;
  }, [view.isMyTurn]);

  const position = useMemo(() => {
    const pos = buildPosition(view);
    if (captureAnim) {
      // Move the capturing piece to the intermediate square for the first slide leg.
      const capturingFen = pos[captureAnim.confirmedSquare];
      if (capturingFen) {
        delete pos[captureAnim.confirmedSquare];
        pos[captureAnim.fromSquare] = capturingFen;
      }
      // Keep the captured own piece visible in the position during phase 1 so it
      // doesn't disappear before the attacker arrives.
      if (captureAnim.capturedPieceFen) {
        pos[captureAnim.confirmedSquare] = captureAnim.capturedPieceFen;
      }
    }
    return pos;
  }, [view, captureAnim]);

  const isTurn = view.isMyTurn;
  const canSpyglass = isTurn && !view.spyglassUsedThisTurn && view.plyCount > 0;

  const ownPrefix = playerColor === 'white' ? 'w' : 'b';
  function isOwnPiece(sq: string) { return !!position[sq] && position[sq][0] === ownPrefix; }

  // Build custom square styles
  const customSquareStyles: Record<string, React.CSSProperties> = {};

  // Magnifying glass cursor on empty-appearing squares when spyglass is available and no piece is selected
  if (canSpyglass && !selectedSquare) {
    for (const file of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      for (const rank of ['1', '2', '3', '4', '5', '6', '7', '8']) {
        const sq = `${file}${rank}`;
        if (!isOwnPiece(sq)) {
          customSquareStyles[sq] = {
            ...(customSquareStyles[sq] ?? {}),
            cursor: 'url(/spyglass-cursor.svg) 12 12, zoom-in',
          };
        }
      }
    }
  }

  // Selected piece highlight
  if (selectedSquare) {
    customSquareStyles[selectedSquare] = {
      ...(customSquareStyles[selectedSquare] ?? {}),
      boxShadow: 'inset 0 0 0 4px #4af',
      backgroundColor: 'rgba(64, 170, 255, 0.2)',
    };
  }

  // Spyglass result highlight (own)
  if (spyglassResult) {
    customSquareStyles[spyglassResult.square] = {
      ...(customSquareStyles[spyglassResult.square] ?? {}),
      boxShadow: 'inset 0 0 0 4px gold',
    };
  }

  // Opponent spyglass highlight
  if (opponentSpyglassSquare) {
    customSquareStyles[opponentSpyglassSquare] = {
      ...(customSquareStyles[opponentSpyglassSquare] ?? {}),
      boxShadow: 'inset 0 0 0 4px #c084fc',
      backgroundColor: 'rgba(192, 132, 252, 0.15)',
    };
  }

  // Spooky materialise animation on newly confirmed squares
  for (const sq of animatingInSquares) {
    customSquareStyles[sq] = {
      ...(customSquareStyles[sq] ?? {}),
      animation: `spooky-in ${ANIM_DURATION}ms ease forwards`,
    };
  }

  // King in check
  if (inCheck) {
    const kingPos = view.ownPieces.find(p => p.piece.type === 'king');
    if (kingPos) {
      customSquareStyles[kingPos.square] = {
        ...(customSquareStyles[kingPos.square] ?? {}),
        boxShadow: 'inset 0 0 0 4px red',
        backgroundColor: 'rgba(255, 0, 0, 0.25)',
      };
    }
  }

  function getPromotion(from: Square, to: Square): Move['promotion'] | undefined {
    const piece = position[from];
    if (!piece) return undefined;
    const isPawn = piece[1] === 'P';
    const toRank = to[1];
    if (isPawn && ((piece[0] === 'w' && toRank === '8') || (piece[0] === 'b' && toRank === '1'))) {
      return 'queen';
    }
    return undefined;
  }

  function handleSquareClick(square: string) {
    const sq = square as Square;

    if (selectedSquare) {
      if (sq === selectedSquare) {
        setSelectedSquare(null);
      } else if (isOwnPiece(sq)) {
        setSelectedSquare(sq);
      } else {
        const move = { from: selectedSquare, to: sq, promotion: getPromotion(selectedSquare, sq) };
        lastSubmittedMoveRef.current = move;
        onMove(move);
        setSelectedSquare(null);
      }
      return;
    }

    if (isTurn && isOwnPiece(sq)) {
      setSelectedSquare(sq);
      return;
    }

    if (canSpyglass && !isOwnPiece(sq)) {
      onSpyglass(sq);
    }
  }

  function handlePieceDrop(sourceSquare: string, targetSquare: string): boolean {
    if (!isTurn) return false;
    setSelectedSquare(null);
    const move = { from: sourceSquare as Square, to: targetSquare as Square, promotion: getPromotion(sourceSquare as Square, targetSquare as Square) };
    lastSubmittedMoveRef.current = move;
    onMove(move);
    return true; // Optimistically accept; server will reject if invalid
  }

  const eloTag = eloChange !== null
    ? `  (${eloChange >= 0 ? '+' : ''}${eloChange} ELO)`
    : '';

  const statusText = view.gameOver
    ? view.winner
      ? `Game over — ${view.winner} wins!${eloTag}`
      : `Draw by agreement!${eloTag}`
    : view.drawOfferPending
    ? 'Opponent offers a draw'
    : inCheck
    ? 'You are in check!'
    : isTurn
    ? 'Your turn'
    : "Opponent's turn";

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '0.4rem 1rem 1rem' }}>
      <h2 style={{ fontSize: '1.4rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <img src="/logo.svg" alt="Specter Chess logo" style={{ height: '2.4rem', width: 'auto' }} />
        Specter Chess —{' '}
        <span style={{ textTransform: 'capitalize', color: playerColor === 'white' ? '#f0d9b5' : '#b58863' }}>
          {playerColor}
        </span>
      </h2>

      {/* Status bar */}
      <div
        className={clockPulse && isTurn ? 'clock-pulse' : undefined}
        style={{
          padding: '0.4rem 1.2rem',
          borderRadius: '4px',
          background: inCheck
            ? 'rgba(220, 50, 50, 0.8)'
            : lastRejected
            ? 'rgba(220, 150, 50, 0.8)'
            : view.drawOfferPending
            ? 'rgba(100, 200, 100, 0.25)'
            : 'rgba(255,255,255,0.1)',
          fontSize: '0.95rem',
          fontWeight: 'bold',
          minWidth: '220px',
          textAlign: 'center',
        }}
      >
        {lastRejected ? 'Invalid move — try again' : statusText}
      </div>

      {/* Opponent row: name + ELO + captured pieces + clock */}
      <div style={{ width: boardSize, display: 'flex', alignItems: 'center', gap: '0.5rem', position: 'relative' }}>
        {opponentEmote && (
          <div style={{
            position: 'absolute', bottom: '100%', left: 0,
            marginBottom: '0.3rem',
            background: 'rgba(0,0,0,0.82)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            padding: '0.3rem 0.7rem',
            fontSize: '0.9rem',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 10,
          }}>
            {opponentEmote}
          </div>
        )}
        <span style={{ fontSize: '0.85rem', opacity: 0.65, whiteSpace: 'nowrap' }}>
          {view.opponentName}
        </span>
        <span style={{ fontSize: '0.75rem', opacity: 0.35, whiteSpace: 'nowrap' }}>
          {view.opponentElo}
        </span>
        <div style={{ flex: 1 }}><CapturedPieces pieces={view.capturedByMe} /></div>
        <ClockDisplay timeMs={displayedTime[opponentColor]} active={!view.isMyTurn && !view.gameOver} />
      </div>

      {/* Board */}
      <div style={{ position: 'relative' }}>
        <Chessboard
          id="specter-chess-board"
          boardWidth={boardSize}
          position={position}
          boardOrientation={playerColor}
          onPieceDrop={handlePieceDrop}
          onSquareClick={handleSquareClick}
          customSquareStyles={customSquareStyles}
          arePiecesDraggable={isTurn && !view.gameOver}
          animationDuration={animatingInSquares.size > 0 ? 0 : 200}
        />
        {/* Game over outcome overlay */}
        {showOutcome && (() => {
          const outcomeText = view.winner === null
            ? 'Draw'
            : view.winner === playerColor
            ? 'You Win!'
            : 'You Lose';
          const color = view.winner === null
            ? '#e2e8f0'
            : view.winner === playerColor
            ? '#86efac'
            : '#fca5a5';
          return (
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 30,
            }}>
              <div style={{
                background: 'rgba(0,0,0,0.72)',
                border: `2px solid ${color}`,
                borderRadius: '10px',
                padding: '0.6rem 1.6rem',
                color,
                fontSize: '2rem',
                fontWeight: 'bold',
                letterSpacing: '0.04em',
                textShadow: `0 0 20px ${color}`,
              }}>
                {outcomeText}
              </div>
            </div>
          );
        })()}

        {/* Spyglass result label overlaid on the target square */}
        {spyglassResult && (() => {
          const { top, left } = squareToPixel(spyglassResult.square, playerColor, squareSize);
          const label = spyglassResult.piece
            ? `${spyglassResult.piece.color} ${spyglassResult.piece.type}`
            : 'empty';
          return (
            <div
              style={{
                position: 'absolute',
                top: top + squareSize / 2,
                left: left + squareSize / 2,
                transform: 'translate(-50%, -50%)',
                background: 'rgba(0,0,0,0.82)',
                border: '1px solid gold',
                borderRadius: '4px',
                padding: '0.2rem 0.45rem',
                color: 'gold',
                fontSize: '0.72rem',
                fontWeight: 'bold',
                pointerEvents: 'none',
                zIndex: 20,
                whiteSpace: 'nowrap',
                textTransform: 'capitalize',
                letterSpacing: '0.03em',
              }}
            >
              {label}
            </div>
          );
        })()}

        {/* Opponent spyglass label overlaid on the target square */}
        {opponentSpyglassSquare && (() => {
          const { top, left } = squareToPixel(opponentSpyglassSquare, playerColor, squareSize);
          return (
            <div
              style={{
                position: 'absolute',
                top: top + squareSize / 2,
                left: left + squareSize / 2,
                transform: 'translate(-50%, -50%)',
                background: 'rgba(0,0,0,0.82)',
                border: '1px solid #c084fc',
                borderRadius: '4px',
                padding: '0.2rem 0.45rem',
                color: '#c084fc',
                fontSize: '0.72rem',
                fontWeight: 'bold',
                pointerEvents: 'none',
                zIndex: 20,
                whiteSpace: 'nowrap',
                letterSpacing: '0.03em',
              }}
            >
              Opponent Spy
            </div>
          );
        })()}

        {/* Flame streak overlays for capture slides */}
        {flameTrails.map(trail => {
          const { left: fx1, top: fy1 } = squareToPixel(trail.from, playerColor, squareSize);
          const { left: fx2, top: fy2 } = squareToPixel(trail.to,   playerColor, squareSize);
          const x1 = fx1 + squareSize / 2;
          const y1 = fy1 + squareSize / 2;
          const x2 = fx2 + squareSize / 2;
          const y2 = fy2 + squareSize / 2;
          const filterId = `flame-glow-${trail.id}`;
          const anim = (delay = 0) =>
            `flame-trail ${TRAIL_DURATION}ms ${delay}ms ease-out both`;
          // Particles evenly spaced along the path
          const particles = Array.from({ length: 5 }, (_, i) => {
            const t = (i + 1) / 6;
            return {
              cx: x1 + (x2 - x1) * t,
              cy: y1 + (y2 - y1) * t,
              r: squareSize * (0.05 + 0.03 * (i % 3)),
              fill: i % 2 === 0 ? '#ff6600' : '#ffdd00',
              delay: i * 25,
            };
          });
          return (
            <svg
              key={trail.id}
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 12, overflow: 'visible' }}
              width={boardSize}
              height={boardSize}
            >
              <defs>
                <filter id={filterId} x="-100%" y="-100%" width="300%" height="300%">
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              {/* Outer glow */}
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="#ff2200" strokeWidth={squareSize * 0.18} strokeLinecap="round"
                filter={`url(#${filterId})`} style={{ animation: anim() }} />
              {/* Mid flame */}
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="#ff8800" strokeWidth={squareSize * 0.09} strokeLinecap="round"
                style={{ animation: anim() }} />
              {/* Hot core */}
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="#ffee44" strokeWidth={squareSize * 0.035} strokeLinecap="round"
                style={{ animation: anim() }} />
              {/* Flame particles */}
              {particles.map((p, i) => (
                <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill}
                  filter={`url(#${filterId})`}
                  style={{ animation: anim(p.delay) }} />
              ))}
            </svg>
          );
        })}

        {/* Fade-out overlay for the captured own piece while the attacker slides in */}
        {capturedOverlay && (() => {
          const { top, left } = squareToPixel(capturedOverlay.square, playerColor, squareSize);
          const { piece } = capturedOverlay;
          return (
            <div
              style={{
                position: 'absolute',
                top,
                left,
                width: squareSize,
                height: squareSize,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: squareSize * 0.75,
                lineHeight: 1,
                animation: 'spooky-out 200ms ease forwards',
                color: piece.color === 'white' ? '#f0f0f0' : '#1a1a1a',
                textShadow: piece.color === 'white'
                  ? '0 0 4px rgba(0,0,0,0.9)'
                  : '0 0 4px rgba(255,255,255,0.5)',
                pointerEvents: 'none',
                zIndex: 11,
              }}
            >
              {UNICODE_PIECE[`${piece.color}-${piece.type}`]}
            </div>
          );
        })()}

        {/* Spooky dissolve-out overlay for stale pieces that just vanished */}
        {animatingOutPieces.length > 0 && (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 10 }}>
            {animatingOutPieces.map(({ id, square, piece }) => {
              const { top, left } = squareToPixel(square, playerColor, squareSize);
              return (
                <div
                  key={id}
                  style={{
                    position: 'absolute',
                    top,
                    left,
                    width: squareSize,
                    height: squareSize,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: squareSize * 0.75,
                    lineHeight: 1,
                    animation: `spooky-out ${ANIM_DURATION}ms ease forwards`,
                    color: piece.color === 'white' ? '#f0f0f0' : '#1a1a1a',
                    textShadow: piece.color === 'white'
                      ? '0 0 4px rgba(0,0,0,0.9)'
                      : '0 0 4px rgba(255,255,255,0.5)',
                  }}
                >
                  {UNICODE_PIECE[`${piece.color}-${piece.type}`]}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* My row: name + ELO + captured pieces + clock */}
      <div style={{ width: boardSize, display: 'flex', alignItems: 'center', gap: '0.5rem', position: 'relative' }}>
        {myEmote && (
          <div style={{
            position: 'absolute', bottom: '100%', left: 0,
            marginBottom: '0.3rem',
            background: 'rgba(0,0,0,0.82)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            padding: '0.3rem 0.7rem',
            fontSize: '0.9rem',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 10,
          }}>
            {myEmote}
          </div>
        )}
        <span style={{ fontSize: '0.85rem', opacity: 0.65, whiteSpace: 'nowrap' }}>
          {view.playerName}
        </span>
        <span style={{ fontSize: '0.75rem', opacity: 0.35, whiteSpace: 'nowrap' }}>
          {view.playerElo}
        </span>
        <div style={{ flex: 1 }}><CapturedPieces pieces={view.capturedByOpponent} /></div>
        <ClockDisplay timeMs={displayedTime[playerColor]} active={view.isMyTurn && !view.gameOver} pulse={clockPulse} />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', position: 'relative' }}>
        {/* Spyglass indicator */}
        <div
          style={{
            padding: '0.5rem 1.2rem',
            borderRadius: '4px',
            border: '2px solid',
            borderColor: canSpyglass ? 'gold' : 'rgba(255,255,255,0.2)',
            background: canSpyglass ? 'rgba(255, 215, 0, 0.15)' : 'rgba(255,255,255,0.03)',
            color: canSpyglass ? '#eee' : '#555',
            fontSize: '1rem',
          }}
        >
          <img src="/spyglass-cursor.svg" alt="spyglass" style={{ width: '1.2em', height: '1.2em', verticalAlign: 'middle', marginRight: '0.4em' }} />
          {view.spyglassUsedThisTurn ? 'Spyglass used' : 'Click empty square'}
        </div>

        {/* Sound toggle */}
        <button
          onClick={() => {
            const next = !soundOn;
            setSoundOn(next);
            setSoundEnabled(next);
          }}
          title={soundOn ? 'Mute sounds' : 'Unmute sounds'}
          style={{
            padding: '0.5rem 0.75rem',
            borderRadius: '4px',
            border: '2px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.06)',
            color: soundOn ? '#eee' : '#555',
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          {soundOn ? '🔊' : '🔇'}
        </button>

        {/* Emote button + picker */}
        {!view.gameOver && (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowEmotePicker(p => !p)}
              style={{
                padding: '0.5rem 1.2rem',
                borderRadius: '4px',
                border: '2px solid rgba(255,255,255,0.2)',
                background: showEmotePicker ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
                color: '#eee',
                cursor: 'pointer',
                fontSize: '1rem',
              }}
            >
              💬
            </button>
            {showEmotePicker && (
              <div style={{
                position: 'absolute',
                bottom: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                marginBottom: '0.4rem',
                background: '#1a1a2e',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '8px',
                padding: '0.4rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.25rem',
                zIndex: 20,
                whiteSpace: 'nowrap',
              }}>
                {CHAT_EMOTES.map(emote => (
                  <button
                    key={emote}
                    onClick={() => { onEmote(emote); setShowEmotePicker(false); }}
                    style={{
                      padding: '0.35rem 0.75rem',
                      borderRadius: '4px',
                      border: 'none',
                      background: 'transparent',
                      color: '#e2e8f0',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      textAlign: 'left',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {emote}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* In-game actions (hidden when game is over) */}
        {!view.gameOver && (
          <>
            {view.isVsBot ? null : view.drawOfferPending ? (
              <>
                <button
                  onClick={onAcceptDraw}
                  style={{
                    padding: '0.5rem 1.2rem',
                    borderRadius: '4px',
                    border: '2px solid rgba(100,200,100,0.6)',
                    background: 'rgba(100,200,100,0.15)',
                    color: '#cfc',
                    cursor: 'pointer',
                    fontSize: '1rem',
                    fontWeight: 'bold',
                  }}
                >
                  Accept Draw
                </button>
                <button
                  onClick={onDeclineDraw}
                  style={{
                    padding: '0.5rem 1.2rem',
                    borderRadius: '4px',
                    border: '2px solid rgba(220,150,50,0.5)',
                    background: 'rgba(220,150,50,0.1)',
                    color: '#fc9',
                    cursor: 'pointer',
                    fontSize: '1rem',
                  }}
                >
                  Decline Draw
                </button>
              </>
            ) : view.myDrawOfferPending ? (
              <div style={{
                padding: '0.5rem 1.2rem',
                borderRadius: '4px',
                border: '1px solid rgba(255,255,255,0.2)',
                color: '#888',
                fontSize: '0.95rem',
                fontStyle: 'italic',
              }}>
                Draw offered…
              </div>
            ) : (
              <button
                onClick={onOfferDraw}
                style={{
                  padding: '0.5rem 1.2rem',
                  borderRadius: '4px',
                  border: '2px solid rgba(180,180,100,0.4)',
                  background: 'rgba(180,180,100,0.1)',
                  color: '#eee',
                  cursor: 'pointer',
                  fontSize: '1rem',
                }}
              >
                Offer Draw
              </button>
            )}
            <button
              onClick={() => { if (confirm('Resign this game?')) onResign(); }}
              style={{
                padding: '0.5rem 1.2rem',
                borderRadius: '4px',
                border: '2px solid rgba(220,80,80,0.5)',
                background: 'rgba(220,80,80,0.1)',
                color: '#f99',
                cursor: 'pointer',
                fontSize: '1rem',
              }}
            >
              Resign
            </button>
          </>
        )}

        {view.gameOver ? (
          <button
            onClick={onReturnToLobby}
            style={{
              padding: '0.5rem 1.2rem',
              borderRadius: '4px',
              border: '2px solid rgba(100,160,255,0.5)',
              background: 'rgba(100,160,255,0.15)',
              color: '#adf',
              cursor: 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
            }}
          >
            Return to Lobby
          </button>
        ) : (
          <button
            onClick={onReset}
            style={{
              padding: '0.5rem 1.2rem',
              borderRadius: '4px',
              border: '2px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.06)',
              color: '#aaa',
              cursor: 'pointer',
              fontSize: '1rem',
            }}
          >
            New Game
          </button>
        )}
      </div>

    </div>
  );
}
