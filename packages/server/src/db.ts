import { turso } from './turso';

export interface PlayerRecord {
  uuid: string;
  name: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
}

export async function initDb(): Promise<void> {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS players (
      uuid   TEXT    PRIMARY KEY,
      name   TEXT    NOT NULL DEFAULT 'Anonymous',
      elo    INTEGER NOT NULL DEFAULT 1200,
      wins   INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws  INTEGER NOT NULL DEFAULT 0
    )
  `);
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS stats (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      games_played INTEGER NOT NULL DEFAULT 0
    )
  `);
  await turso.execute(`INSERT OR IGNORE INTO stats (id, games_played) VALUES (1, 0)`);
}

export async function getPlayer(uuid: string): Promise<PlayerRecord | null> {
  const res = await turso.execute({ sql: `SELECT * FROM players WHERE uuid = ?`, args: [uuid] });
  return res.rows[0] ? rowToPlayer(res.rows[0]) : null;
}

export async function getOrCreatePlayer(uuid: string): Promise<PlayerRecord> {
  await turso.execute({ sql: `INSERT OR IGNORE INTO players (uuid) VALUES (?)`, args: [uuid] });
  const res = await turso.execute({ sql: `SELECT * FROM players WHERE uuid = ?`, args: [uuid] });
  return rowToPlayer(res.rows[0]);
}

export async function updatePlayerName(uuid: string, name: string): Promise<void> {
  await turso.execute({ sql: `UPDATE players SET name = ? WHERE uuid = ?`, args: [name, uuid] });
}

export async function isNameTaken(name: string, excludeUuid: string): Promise<boolean> {
  const res = await turso.execute({
    sql: `SELECT 1 FROM players WHERE name = ? AND uuid != ? LIMIT 1`,
    args: [name, excludeUuid],
  });
  return res.rows.length > 0;
}

export async function updateElo(
  uuid: string,
  newElo: number,
  result: 'win' | 'loss' | 'draw',
): Promise<PlayerRecord> {
  const col = result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws';
  await turso.execute({
    sql: `UPDATE players SET elo = ?, ${col} = ${col} + 1 WHERE uuid = ?`,
    args: [newElo, uuid],
  });
  const res = await turso.execute({ sql: `SELECT * FROM players WHERE uuid = ?`, args: [uuid] });
  return rowToPlayer(res.rows[0]);
}

export async function getGamesPlayed(): Promise<number> {
  const res = await turso.execute(`SELECT games_played FROM stats WHERE id = 1`);
  return Number(res.rows[0]?.games_played ?? 0);
}

export async function incrementGamesPlayed(): Promise<void> {
  await turso.execute(`UPDATE stats SET games_played = games_played + 1 WHERE id = 1`);
}

function rowToPlayer(row: Record<string, unknown>): PlayerRecord {
  return {
    uuid:   String(row.uuid),
    name:   String(row.name),
    elo:    Number(row.elo),
    wins:   Number(row.wins),
    losses: Number(row.losses),
    draws:  Number(row.draws),
  };
}

// ─── ELO (pure computation — no DB) ───────────────────────────────────────────

export function calcNewElo(
  playerElo: number,
  opponentElo: number,
  result: 0 | 0.5 | 1,
): number {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
  return Math.round(playerElo + K * (result - expected));
}
