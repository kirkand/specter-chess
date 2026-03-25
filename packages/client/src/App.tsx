import { useEffect, useRef, useState } from 'react';
import { socket } from './socket';
import { GameBoard } from './GameBoard';
import type { Color, PlayerView, SpyglassResult, GameListing, PlayerRating, BotDifficulty } from '@specter-chess/shared';

function getOrCreateUuid(): string {
  const key = 'specter-uuid';
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const uuid = crypto.randomUUID();
  localStorage.setItem(key, uuid);
  return uuid;
}

const MY_UUID = getOrCreateUuid();

type AppState =
  | { phase: 'connecting' }
  | { phase: 'lobby'; openGames: GameListing[]; joinError: string | null }
  | { phase: 'waiting'; gameId: string }
  | { phase: 'playing'; color: Color; view: PlayerView }
  | { phase: 'disconnected' };

export default function App() {
  const [state, setState] = useState<AppState>({ phase: 'connecting' });
  const [spyglassResult, setSpyglassResult] = useState<SpyglassResult | null>(null);
  const [opponentSpyglassSquare, setOpponentSpyglassSquare] = useState<string | null>(null);
  const [lastRejected, setLastRejected] = useState(false);
  const [inCheck, setInCheck] = useState(false);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('specter-name') ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const playerNameRef = useRef(playerName);
  useEffect(() => { playerNameRef.current = playerName; }, [playerName]);

  const [myRating, setMyRating] = useState<PlayerRating | null>(null);
  const [serverStats, setServerStats] = useState<{ onlineCount: number; gamesPlayed: number } | null>(null);
  const [eloChange, setEloChange] = useState<number | null>(null);
  // Snapshot ELO at game start so delta is computed correctly after result
  const preGameEloRef = useRef<number | null>(null);

  function handleNameChange(name: string) {
    setPlayerName(name);
    setNameError(null);
    localStorage.setItem('specter-name', name);
    if (name.trim()) socket.emit('set_name', name.trim());
  }

  useEffect(() => {
    function onConnect() {
      socket.emit('register', MY_UUID);
      if (playerNameRef.current.trim()) socket.emit('set_name', playerNameRef.current.trim());
      setState(prev =>
        prev.phase === 'connecting'
          ? { phase: 'lobby', openGames: [], joinError: null }
          : prev
      );
    }

    socket.on('connect', onConnect);
    if (socket.connected) onConnect();

    socket.on('open_games_update', (games: GameListing[]) => {
      setState(prev =>
        prev.phase === 'lobby' ? { ...prev, openGames: games } : prev
      );
    });

    socket.on('game_created', (gameId: string) => {
      setState({ phase: 'waiting', gameId });
    });

    socket.on('join_failed', (reason: string) => {
      setState(prev =>
        prev.phase === 'lobby' ? { ...prev, joinError: reason } : prev
      );
    });

    socket.on('waiting_for_opponent', () => {
      // Fallback in case game_created wasn't received
      setState(prev =>
        prev.phase !== 'playing' && prev.phase !== 'waiting'
          ? { phase: 'waiting', gameId: '' }
          : prev
      );
    });

    socket.on('game_start', (color: Color) => {
      // Snapshot current ELO so we can compute the delta after the game
      preGameEloRef.current = myRating?.elo ?? null;
      setEloChange(null);
      setState(prev => ({
        phase: 'playing',
        color,
        view: (prev as any).view ?? null,
      }));
    });

    socket.on('game_state_update', (view: PlayerView) => {
      setState(prev => {
        if (prev.phase !== 'playing') return prev;
        return { ...prev, view };
      });
      setInCheck(view.inCheck);
      if (view.isMyTurn) setLastRejected(false);
    });

    socket.on('spyglass_result', (result: SpyglassResult) => {
      setSpyglassResult(result);
      setTimeout(() => setSpyglassResult(null), 3000);
    });

    socket.on('opponent_spyglass', (square: string) => {
      setOpponentSpyglassSquare(square);
      setTimeout(() => setOpponentSpyglassSquare(null), 3000);
    });

    socket.on('move_rejected', () => {
      setLastRejected(true);
      setTimeout(() => setLastRejected(false), 1500);
    });

    socket.on('check_notification', () => {
      setInCheck(true);
    });

    socket.on('opponent_disconnected', () => {
      setState({ phase: 'disconnected' });
    });

    socket.on('name_rejected', (reason: string) => {
      setNameError(reason);
    });

    socket.on('stats_update', (stats: { onlineCount: number; gamesPlayed: number }) => {
      setServerStats(stats);
    });

    socket.on('rating_update', (rating: PlayerRating) => {
      setMyRating(rating);
      if (preGameEloRef.current !== null) {
        setEloChange(rating.elo - preGameEloRef.current);
        preGameEloRef.current = null;
      }
    });

    return () => {
      socket.removeAllListeners();
    };
  }, []);

  if (state.phase === 'connecting') {
    return <StatusScreen message="Connecting to server…" />;
  }

  if (state.phase === 'lobby') {
    return (
      <LobbyScreen
        openGames={state.openGames}
        joinError={state.joinError}
        playerName={playerName}
        nameError={nameError}
        myRating={myRating}
        onNameChange={handleNameChange}
        serverStats={serverStats}
        onRefresh={() => socket.emit('get_open_games')}
        onCreateGame={timeControl => socket.emit('create_game', timeControl)}
        onCreateBotGame={(difficulty, timeControl) => socket.emit('create_bot_game', { difficulty, timeControl })}
        onJoinGame={gameId => socket.emit('join_game', gameId)}
      />
    );
  }

  if (state.phase === 'waiting') {
    return (
      <StatusScreen
        message="Waiting for opponent…"
        hint={state.gameId ? `Game ID: ${state.gameId}` : 'Open a second tab to play'}
      />
    );
  }

  if (state.phase === 'disconnected') {
    return (
      <StatusScreen
        message="Opponent disconnected."
        hint="Refresh to return to the lobby."
      />
    );
  }

  if (state.phase === 'playing' && state.view) {
    return (
      <GameBoard
        view={state.view}
        playerColor={state.color}
        spyglassResult={spyglassResult}
        opponentSpyglassSquare={opponentSpyglassSquare}
        lastRejected={lastRejected}
        inCheck={inCheck}
        eloChange={eloChange}
        onMove={move => socket.emit('move_attempt', move)}
        onSpyglass={square => socket.emit('spyglass_query', { square })}
        onResign={() => socket.emit('resign')}
        onOfferDraw={() => socket.emit('offer_draw')}
        onAcceptDraw={() => socket.emit('accept_draw')}
        onDeclineDraw={() => socket.emit('decline_draw')}
        onReset={() => {
          socket.emit('reset_game');
          setInCheck(false);
          setLastRejected(false);
          setSpyglassResult(null);
          setEloChange(null);
        }}
        onReturnToLobby={() => {
          setInCheck(false);
          setLastRejected(false);
          setSpyglassResult(null);
          setEloChange(null);
          setState({ phase: 'lobby', openGames: [], joinError: null });
          socket.emit('get_open_games');
        }}
      />
    );
  }

  return <StatusScreen message="Loading…" />;
}

// ─── Lobby ───────────────────────────────────────────────────────────────────

const TIME_CONTROL_OPTIONS = [3, 5, 10, 15, 30, 60]; // minutes

const BOT_DIFFICULTIES: { value: BotDifficulty; label: string }[] = [
  { value: 'easy',   label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard',   label: 'Hard' },
];

function LobbyScreen({
  openGames,
  joinError,
  playerName,
  nameError,
  myRating,
  serverStats,
  onRefresh,
  onNameChange,
  onCreateGame,
  onCreateBotGame,
  onJoinGame,
}: {
  openGames: GameListing[];
  joinError: string | null;
  playerName: string;
  nameError: string | null;
  myRating: PlayerRating | null;
  serverStats: { onlineCount: number; gamesPlayed: number } | null;
  onRefresh: () => void;
  onNameChange: (name: string) => void;
  onCreateGame: (timeControlSeconds: number) => void;
  onCreateBotGame: (difficulty: BotDifficulty, timeControlSeconds: number) => void;
  onJoinGame: (gameId: string) => void;
}) {
  const [selectedMinutes, setSelectedMinutes] = useState(10);
  const [selectedDifficulty, setSelectedDifficulty] = useState<BotDifficulty>('medium');
  const [rulesOpen, setRulesOpen] = useState(
    () => localStorage.getItem('specter-rules-open') !== 'false'
  );
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);

  function toggleRules() {
    const next = !rulesOpen;
    setRulesOpen(next);
    localStorage.setItem('specter-rules-open', String(next));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem', padding: '2rem' }}>
      <img src="/logo.svg" alt="Specter Chess logo" style={{ height: '5rem', width: 'auto' }} />
      <h1 style={{ fontSize: '2rem', margin: 0 }}>Specter Chess</h1>

      {serverStats && (
        <div style={{ fontSize: '0.8rem', opacity: 0.45, display: 'flex', gap: '1rem' }}>
          <span>● {serverStats.onlineCount} online</span>
          <span>{serverStats.gamesPlayed.toLocaleString()} games played</span>
        </div>
      )}

      {/* Rules */}
      <div style={{ width: '100%', maxWidth: '680px' }}>
        <button
          onClick={toggleRules}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.4rem',
            width: '100%',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0.2rem 0',
            marginBottom: '0.75rem',
          }}
        >
          <span style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#60a5fa', fontWeight: 600 }}>
            How to Play
          </span>
          <span style={{
            fontSize: '0.65rem',
            color: '#60a5fa',
            opacity: 0.7,
            transform: rulesOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.25s ease',
            display: 'inline-block',
          }}>▼</span>
        </button>
        <div style={{
          overflow: 'hidden',
          maxHeight: rulesOpen ? '600px' : '0px',
          opacity: rulesOpen ? 1 : 0,
          transition: rulesOpen
            ? 'max-height 0.35s ease, opacity 0.25s ease'
            : 'max-height 0.25s ease, opacity 0.15s ease',
        }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {[
            {
              img: '/rule1-hidden-move.svg',
              alt: 'Hidden move illustration',
              text: "Specter Chess tests your anticipation abilities. Your opponent's most recent move is always hidden to you.",
            },
            {
              img: '/rule2-spyglass.svg',
              alt: 'Spyglass illustration',
              text: "Tap/click on any unoccupied square once per turn to activate the spyglass. It will reveal if your opponent's piece is hiding on that square.",
            },
            {
              img: '/rule3-capture-reveals.svg',
              alt: 'Capture reveals illustration',
              text: "When a piece is taken, the attacking piece's identity and location is revealed.",
            },
          ].map((rule, i) => (
            <div
              key={i}
              style={{
                flex: '1 1 180px',
                maxWidth: '210px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.75rem',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <img src={rule.img} alt={rule.alt} style={{ width: '100%', borderRadius: '6px' }} />
              <p style={{ fontSize: '0.78rem', lineHeight: 1.5, opacity: 0.65, margin: 0, textAlign: 'center' }}>
                {rule.text}
              </p>
            </div>
          ))}
        </div>
        </div>
      </div>

      {/* Name input */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem' }}>
        <label style={{ fontSize: '0.85rem', opacity: 0.55 }}>Display Name</label>
        <input
          type="text"
          value={playerName}
          maxLength={20}
          placeholder="Enter a name…"
          onChange={e => onNameChange(e.target.value)}
          style={{
            padding: '0.45rem 0.8rem',
            borderRadius: '5px',
            border: nameError ? '1px solid rgba(220,80,80,0.8)' : '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.07)',
            color: '#eee',
            fontSize: '1rem',
            width: '200px',
            outline: 'none',
            textAlign: 'center',
          }}
        />
        {nameError && <span style={{ fontSize: '0.8rem', color: '#f77' }}>{nameError}</span>}
        {myRating && (
          <span style={{ fontSize: '0.8rem', opacity: 0.5 }}>
            {myRating.elo} ELO &nbsp;·&nbsp; {myRating.wins}W {myRating.losses}L {myRating.draws}D
          </span>
        )}
      </div>

      {/* Play vs Bot */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem' }}>
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          {BOT_DIFFICULTIES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setSelectedDifficulty(value)}
              style={{
                padding: '0.3rem 0.65rem',
                borderRadius: '4px',
                border: `1px solid ${selectedDifficulty === value ? 'rgba(100,160,255,0.7)' : 'rgba(255,255,255,0.15)'}`,
                background: selectedDifficulty === value ? 'rgba(100,160,255,0.2)' : 'rgba(255,255,255,0.05)',
                color: selectedDifficulty === value ? '#adf' : '#888',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: selectedDifficulty === value ? 'bold' : 'normal',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => onCreateBotGame(selectedDifficulty, selectedMinutes * 60)}
          disabled={!playerName.trim() || !!nameError}
          style={{
            padding: '0.7rem 1.8rem',
            borderRadius: '6px',
            border: '2px solid rgba(100,160,255,0.5)',
            background: 'rgba(100,160,255,0.12)',
            color: '#eee',
            cursor: !playerName.trim() || !!nameError ? 'not-allowed' : 'pointer',
            fontSize: '1.1rem',
            fontWeight: 'bold',
            opacity: !playerName.trim() || !!nameError ? 0.35 : 1,
          }}
        >
          Play vs Bot
        </button>
      </div>

      {/* Time control selector */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ fontSize: '0.85rem', opacity: 0.55 }}>Time control (per player)</span>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {TIME_CONTROL_OPTIONS.map(mins => (
            <button
              key={mins}
              onClick={() => setSelectedMinutes(mins)}
              style={{
                padding: '0.35rem 0.7rem',
                borderRadius: '4px',
                border: `1px solid ${selectedMinutes === mins ? 'rgba(100,200,100,0.7)' : 'rgba(255,255,255,0.15)'}`,
                background: selectedMinutes === mins ? 'rgba(100,200,100,0.2)' : 'rgba(255,255,255,0.05)',
                color: selectedMinutes === mins ? '#cfc' : '#aaa',
                cursor: 'pointer',
                fontSize: '0.9rem',
                fontWeight: selectedMinutes === mins ? 'bold' : 'normal',
              }}
            >
              {mins}m
            </button>
          ))}
        </div>
      </div>

      {/* Create Game (vs Human) */}
      <button
        onClick={() => onCreateGame(selectedMinutes * 60)}
        disabled={!playerName.trim() || !!nameError}
        style={{
          padding: '0.7rem 2rem',
          borderRadius: '6px',
          border: '2px solid rgba(100, 200, 100, 0.5)',
          background: 'rgba(100, 200, 100, 0.15)',
          color: '#eee',
          cursor: !playerName.trim() || !!nameError ? 'not-allowed' : 'pointer',
          fontSize: '1.1rem',
          fontWeight: 'bold',
          opacity: !playerName.trim() || !!nameError ? 0.35 : 1,
        }}
      >
        Create Game
      </button>

      {joinError && (
        <div style={{ color: '#f88', fontSize: '0.9rem' }}>{joinError}</div>
      )}

      <div style={{ width: '100%', maxWidth: '420px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <h2 style={{ fontSize: '1rem', opacity: 0.6, margin: 0 }}>
            {openGames.length === 0 ? 'No open games — create one!' : 'Open Games'}
          </h2>
          <button
            onClick={onRefresh}
            title="Refresh"
            style={{
              background: 'none',
              border: 'none',
              color: '#aaa',
              cursor: 'pointer',
              fontSize: '1rem',
              padding: '0 0.2rem',
              lineHeight: 1,
              opacity: 0.5,
            }}
          >
            ↻
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {openGames.map(game => (
            <div
              key={game.gameId}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.6rem 1rem',
                borderRadius: '6px',
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: '1rem', letterSpacing: '0.05em' }}>
                {game.gameId}
              </span>
              <span style={{ fontSize: '0.85rem', opacity: 0.6, whiteSpace: 'nowrap' }}>
                {game.timeControl / 60}m
              </span>
              <span style={{ fontSize: '0.8rem', opacity: 0.4, flex: 1, textAlign: 'right' }}>
                {formatAge(game.createdAt)}
              </span>
              <button
                onClick={() => onJoinGame(game.gameId)}
                disabled={!playerName.trim() || !!nameError}
                style={{
                  padding: '0.35rem 1rem',
                  borderRadius: '4px',
                  border: '1px solid rgba(100, 160, 255, 0.5)',
                  background: 'rgba(100, 160, 255, 0.15)',
                  color: '#eee',
                  cursor: !playerName.trim() || !!nameError ? 'not-allowed' : 'pointer',
                  fontSize: '0.9rem',
                  opacity: !playerName.trim() || !!nameError ? 0.35 : 1,
                }}
              >
                Join
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ marginTop: '1rem', fontSize: '0.75rem', opacity: 0.35, textAlign: 'center', lineHeight: 1.8 }}>
        <button onClick={() => setPrivacyOpen(true)} style={footerLinkStyle}>Privacy Policy</button>
        {' · '}
        <button onClick={() => setCreditsOpen(true)} style={footerLinkStyle}>Open Source Credits</button>
        <br />
        © 2026 Specter Chess. All rights reserved.{' · '}You must be 13 or older to play.
      </div>

      {privacyOpen && <PrivacyPolicyModal onClose={() => setPrivacyOpen(false)} />}
      {creditsOpen && <CreditsModal onClose={() => setCreditsOpen(false)} />}
    </div>
  );
}

// ─── Shared footer style ─────────────────────────────────────────────────────

const footerLinkStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: 'inherit',
  cursor: 'pointer', textDecoration: 'underline',
  fontSize: 'inherit', padding: 0,
};

// ─── Privacy Policy ──────────────────────────────────────────────────────────

function PrivacyPolicyModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#1a1a2e',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '10px',
          padding: '2rem',
          maxWidth: '580px',
          width: '100%',
          maxHeight: '80vh',
          overflowY: 'auto',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: '1rem', right: '1rem',
            background: 'none', border: 'none', color: '#aaa',
            fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1,
          }}
        >
          ×
        </button>

        <h2 style={{ margin: '0 0 1.2rem', fontSize: '1.3rem', color: '#e2e8f0' }}>
          Privacy Policy
        </h2>

        <Section title="Age Requirement">
          You must be at least <strong>13 years old</strong> to use Specter Chess.
          By playing, you confirm that you meet this requirement. If you are under 13,
          please do not use this service.
        </Section>

        <Section title="What We Collect">
          <p>Specter Chess collects minimal data necessary to provide the game experience:</p>
          <ul>
            <li>
              <strong>Anonymous player ID (UUID)</strong> — A randomly generated identifier
              is created the first time you visit and stored in your browser's{' '}
              <code>localStorage</code>. It is never linked to your name, email, or any
              personal information. Clearing your browser's site data will generate a new ID.
            </li>
            <li>
              <strong>Display name</strong> — The name you choose to display in-game.
              This is voluntary and can be anything you like. We do not recommend to use your real full name. 
              Display names are not linked to UUID in our database.
            </li>
            <li>
              <strong>Game records</strong> — Each completed PvP game is logged in our
              database with the following fields: timestamp, game ID, both players'
              anonymous UUIDs, game duration, time control, match outcome, and ELO ratings
              before and after the game.
            </li>
            <li>
              <strong>ELO rating</strong> — A skill rating derived from your game history,
              associated only with your anonymous UUID.
            </li>
          </ul>
        </Section>

        <Section title="What We Do Not Collect">
          We do not store or process your name, email address, IP address, location, device
          identifiers, or any information that could identify you as an individual.
          We do not use cookies. We do not serve advertisements.
        </Section>

        <Section title="How Your Data Is Used">
          Collected data is used solely to operate the game: tracking win/loss records,
          computing ELO ratings, and maintaining leaderboards. Game records may be used
          in aggregate and anonymised form to improve the game.
        </Section>

        <Section title="Data Storage">
          Game data is stored on our server in a SQLite database. Your UUID is stored
          only in your own browser's <code>localStorage</code> — it is sent to the server
          only when you register a session via our real-time connection.
        </Section>

        <Section title="Data Retention & Deletion">
          There is currently no automated data expiry. Because all data is tied to an
          anonymous UUID rather than a personal identity, we have no way to look up or
          delete records on request without you providing your UUID. You can effectively
          "reset" your account at any time by clearing your browser's site data, which
          will generate a fresh UUID.
        </Section>

        <Section title="Changes to This Policy">
          This policy may be updated as the game evolves. Continued use of the site
          after changes constitutes acceptance of the revised policy.
        </Section>

        <p style={{ marginTop: '1.5rem', fontSize: '0.75rem', opacity: 0.35, textAlign: 'center' }}>
          Last updated: March 2026
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.2rem' }}>
      <h3 style={{ fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#60a5fa', marginBottom: '0.4rem' }}>
        {title}
      </h3>
      <div style={{ fontSize: '0.85rem', lineHeight: 1.65, opacity: 0.75 }}>
        {children}
      </div>
    </div>
  );
}

// ─── Credits ─────────────────────────────────────────────────────────────────

const CREDITS: { name: string; description: string; license: string; url: string }[] = [
  { name: 'chess.js',         description: 'Chess move generation and validation engine',        license: 'BSD-2-Clause', url: 'https://github.com/jhlywa/chess.js' },
  { name: 'React',            description: 'UI component framework',                             license: 'MIT',          url: 'https://react.dev' },
  { name: 'react-chessboard', description: 'Interactive chessboard UI component',               license: 'MIT',          url: 'https://github.com/Clariity/react-chessboard' },
  { name: 'Socket.IO',        description: 'Real-time bidirectional event-based communication', license: 'MIT',          url: 'https://socket.io' },
  { name: 'Express',          description: 'Web server framework for Node.js',                  license: 'MIT',          url: 'https://expressjs.com' },
  { name: 'bad-words',        description: 'Profanity filter for display names',                license: 'MIT',          url: 'https://github.com/web-mech/badwords' },
  { name: 'Vite',             description: 'Frontend build tool',                               license: 'MIT',          url: 'https://vitejs.dev' },
  { name: 'TypeScript',       description: 'Typed JavaScript',                                  license: 'Apache-2.0',   url: 'https://www.typescriptlang.org' },
  { name: 'ts-node-dev',      description: 'TypeScript development server with hot reload',     license: 'MIT',          url: 'https://github.com/wclr/ts-node-dev' },
  { name: 'Node.js SQLite',   description: 'Built-in SQLite database module (Node.js 22+)',     license: 'Node.js License', url: 'https://nodejs.org/api/sqlite.html' },
  { name: 'Chess Programming Wiki — Piece-Square Tables', description: 'Positional evaluation tables used in the bot engine', license: 'Public Domain', url: 'https://www.chessprogramming.org/Piece-Square_Tables' },
];

function CreditsModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#1a1a2e',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '10px',
          padding: '2rem',
          maxWidth: '580px',
          width: '100%',
          maxHeight: '80vh',
          overflowY: 'auto',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: '1rem', right: '1rem',
            background: 'none', border: 'none', color: '#aaa',
            fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1,
          }}
        >×</button>

        <h2 style={{ margin: '0 0 1.2rem', fontSize: '1.3rem', color: '#e2e8f0' }}>
          Open Source Credits
        </h2>
        <p style={{ fontSize: '0.82rem', opacity: 0.6, marginBottom: '1.2rem', lineHeight: 1.5 }}>
          Specter Chess is built on the shoulders of these open source projects. Thank you to all the contributors.
        </p>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', textAlign: 'left', opacity: 0.45 }}>
              <th style={{ paddingBottom: '0.4rem', fontWeight: 600 }}>Library</th>
              <th style={{ paddingBottom: '0.4rem', fontWeight: 600 }}>License</th>
            </tr>
          </thead>
          <tbody>
            {CREDITS.map(c => (
              <tr key={c.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <td style={{ padding: '0.55rem 0.5rem 0.55rem 0', verticalAlign: 'top' }}>
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#60a5fa', textDecoration: 'none', fontWeight: 600 }}
                  >
                    {c.name}
                  </a>
                  <div style={{ opacity: 0.5, marginTop: '0.15rem', lineHeight: 1.4 }}>{c.description}</div>
                </td>
                <td style={{ padding: '0.55rem 0', verticalAlign: 'top', whiteSpace: 'nowrap', opacity: 0.55 }}>
                  {c.license}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p style={{ marginTop: '1.5rem', fontSize: '0.75rem', opacity: 0.35, textAlign: 'center' }}>
          © 2026 Specter Chess. All rights reserved.
        </p>
      </div>
    </div>
  );
}

function formatAge(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

// ─── Status screen ───────────────────────────────────────────────────────────

function StatusScreen({ message, hint }: { message: string; hint?: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <img src="/logo.svg" alt="Specter Chess logo" style={{ height: '5rem', width: 'auto', marginBottom: '0.5rem' }} />
      <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>Specter Chess</h1>
      <p style={{ fontSize: '1.2rem', opacity: 0.8 }}>{message}</p>
      {hint && <p style={{ marginTop: '0.5rem', opacity: 0.5, fontSize: '0.9rem' }}>{hint}</p>}
    </div>
  );
}
