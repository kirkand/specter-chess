import { turso } from './turso';

export type GameOutcome = 'white_wins' | 'black_wins' | 'draw';

export async function initGameDb(): Promise<void> {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS games (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp        INTEGER NOT NULL,
      game_id          TEXT    NOT NULL,
      player1_uuid     TEXT    NOT NULL,
      player2_uuid     TEXT    NOT NULL,
      length_ms        INTEGER,
      outcome          TEXT    NOT NULL,
      set_length       INTEGER,
      player1_orig_elo INTEGER,
      player1_new_elo  INTEGER,
      player2_orig_elo INTEGER,
      player2_new_elo  INTEGER
    )
  `);
}

export async function recordGame(params: {
  gameId: string;
  player1Uuid: string;
  player2Uuid: string;
  lengthMs: number | null;
  outcome: GameOutcome;
  setLengthMinutes: number;
  player1OrigElo: number;
  player1NewElo: number;
  player2OrigElo: number;
  player2NewElo: number;
}): Promise<void> {
  await turso.execute({
    sql: `
      INSERT INTO games (
        timestamp, game_id, player1_uuid, player2_uuid, length_ms, outcome,
        set_length, player1_orig_elo, player1_new_elo, player2_orig_elo, player2_new_elo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      Date.now(),
      params.gameId,
      params.player1Uuid,
      params.player2Uuid,
      params.lengthMs ?? null,
      params.outcome,
      params.setLengthMinutes,
      params.player1OrigElo,
      params.player1NewElo,
      params.player2OrigElo,
      params.player2NewElo,
    ],
  });
}
