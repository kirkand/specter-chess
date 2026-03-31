// ─── Primitives ──────────────────────────────────────────────────────────────

export type Color = 'white' | 'black';

export type PieceType = 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn';

export interface Piece {
  type: PieceType;
  color: Color;
}

/** Algebraic notation square, e.g. "e4" */
export type Square = string;

export interface PiecePosition {
  square: Square;
  piece: Piece;
}

export interface Move {
  from: Square;
  to: Square;
  promotion?: PieceType;
}

// ─── Spyglass ────────────────────────────────────────────────────────────────

export interface SpyglassRequest {
  square: Square;
}

/** Piece is null when the square is empty */
export interface SpyglassResult {
  square: Square;
  piece: Piece | null;
}

// ─── Player view ─────────────────────────────────────────────────────────────

/**
 * What one player can see:
 *  - their own pieces at true current positions
 *  - opponent pieces at their stale snapshot positions (1 move behind)
 *  - opponent pieces at confirmed positions revealed by spyglass (override snapshot)
 */
export interface PlayerView {
  color: Color;
  ownPieces: PiecePosition[];
  /** Opponent positions from before their latest move */
  opponentSnapshot: PiecePosition[];
  /** Squares confirmed via spyglass this game (cleared when piece moves) */
  confirmedOpponentPositions: PiecePosition[];
  isMyTurn: boolean;
  inCheck: boolean;
  spyglassUsedThisTurn: boolean;
  capturedByMe: Piece[];
  capturedByOpponent: Piece[];
  /** Total half-moves played so far (0 = game just started, spyglass unavailable for White) */
  plyCount: number;
  gameOver: boolean;
  winner: Color | null;
  timeRemainingMs: { white: number; black: number };
  playerName: string;
  opponentName: string;
  playerElo: number;
  opponentElo: number;
  /** Opponent has offered a draw that I haven't yet accepted or declined */
  drawOfferPending: boolean;
  /** I offered a draw and am waiting for the opponent's response */
  myDrawOfferPending: boolean;
  /** Whether this game is against a bot */
  isVsBot: boolean;
  /** Opponent has requested a rematch that I haven't yet accepted or declined */
  rematchRequestedByOpponent: boolean;
  /** I requested a rematch and am waiting for the opponent's response */
  myRematchPending: boolean;
  /**
   * Set when an opponent piece just captured one of our pieces.
   * The square the capturing piece moved FROM — used to animate the two-step
   * reveal: stale-position → fromSquare → capture-square.
   */
  captureRevealFromSquare?: Square;
}

/** Subset returned by SpecterChessGame.getPlayerView() — server augments the rest before sending. */
export type CorePlayerView = Omit<PlayerView, 'timeRemainingMs' | 'playerName' | 'opponentName' | 'playerElo' | 'opponentElo' | 'drawOfferPending' | 'myDrawOfferPending' | 'isVsBot' | 'rematchRequestedByOpponent' | 'myRematchPending'>;

// ─── Move rejection ──────────────────────────────────────────────────────────

export type MoveRejectionReason = 'path_blocked' | 'would_put_in_check' | 'no_piece_to_capture' | 'invalid_piece_move';

// ─── Bot ─────────────────────────────────────────────────────────────────────

export type BotDifficulty = 'easy' | 'medium' | 'hard';

// ─── Rating ──────────────────────────────────────────────────────────────────

export interface PlayerRating {
  elo: number;
  wins: number;
  losses: number;
  draws: number;
}

// ─── Matchmaking ─────────────────────────────────────────────────────────────

export interface GameListing {
  gameId: string;
  createdAt: number; // Unix timestamp ms
  timeControl: number; // seconds per player
  hostName: string;
  hostElo: number;
}

// ─── Chat emotes ─────────────────────────────────────────────────────────────

export const CHAT_EMOTES = [
  'Hello! 👋',
  'Wow! 😮',
  'Good move! 👏',
  'Thanks! 🙏',
  'Noooo! 😱',
  'Good game! 🤝',
] as const;

export type ChatEmote = typeof CHAT_EMOTES[number];

// ─── Socket.io events ────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  /** Full view pushed to a player after any state change */
  game_state_update: (view: PlayerView) => void;
  /** Opponent's spyglass-confirmed piece has moved — clear it from display */
  confirmed_position_invalidated: (square: Square) => void;
  /** Player is in check */
  check_notification: () => void;
  /** Server rejected a move attempt (invalid against true board state) */
  move_rejected: (reason: MoveRejectionReason) => void;
  /** Server rejected a spyglass attempt (already used this turn) */
  spyglass_rejected: (reason: string) => void;
  /** Spyglass result */
  spyglass_result: (result: SpyglassResult) => void;
  /** Opponent used their spyglass on this square */
  opponent_spyglass: (square: Square) => void;
  /** Waiting for opponent to connect */
  waiting_for_opponent: () => void;
  /** Joined a game but host is disconnected — waiting up to 10s for them to return */
  waiting_for_host: () => void;
  /** Host did not reconnect in time — game cancelled */
  host_abandoned: () => void;
  /** Game is starting */
  game_start: (color: Color) => void;
  /** Opponent disconnected */
  opponent_disconnected: () => void;
  /** A new game was created and the creator is waiting */
  game_created: (gameId: string) => void;
  /** Joining a game failed */
  join_failed: (reason: string) => void;
  /** Current list of open (waiting) games */
  open_games_update: (games: GameListing[]) => void;
  /** Live server stats */
  stats_update: (stats: { onlineCount: number; gamesPlayed: number }) => void;
  /** Server rejected the requested screen name */
  name_rejected: (reason: string) => void;
  /** Player's current rating (sent on register and after each rated game) */
  rating_update: (rating: PlayerRating) => void;
  /** Opponent sent a chat emote */
  chat_emote: (text: ChatEmote) => void;
}

export interface ClientToServerEvents {
  move_attempt: (move: Move) => void;
  spyglass_query: (req: SpyglassRequest) => void;
  reset_game: () => void;
  create_game: (options: { timeControl: number; private: boolean }) => void;
  join_game: (gameId: string) => void;
  set_name: (name: string) => void;
  register: (uuid: string) => void;
  get_open_games: () => void;
  cancel_waiting_game: () => void;
  resign: () => void;
  offer_draw: () => void;
  accept_draw: () => void;
  decline_draw: () => void;
  leave_game: () => void;
  create_bot_game: (options: { difficulty: BotDifficulty; timeControl: number }) => void;
  chat_emote: (text: ChatEmote) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  color: Color;
  gameId?: string;
  name: string;
  uuid?: string;
}
