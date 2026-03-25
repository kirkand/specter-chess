import { createClient } from '@libsql/client';

export const turso = createClient({
  url: process.env.TURSO_URL ?? 'file:local.db',
  ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}),
});
