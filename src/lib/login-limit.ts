import { hashTrackingToken } from './tokens';

const windowMs = 60_000;
const maxAttempts = 5;

export async function limitLogin(database: D1Database, secret: string, email: string, ip: string) {
  const keys = await Promise.all([['email', email], ['ip', ip]].map(async ([kind, value]) =>
    'login:' + kind + ':' + await hashTrackingToken(JSON.stringify([secret, kind, value]))));
  const now = Date.now();
  const cutoff = now - windowMs;
  const results = await database.batch([
    ...keys.map((key) => database.prepare(`
      INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
        window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
      WHERE window_start <= ? OR count < ?
      RETURNING count
    `).bind(key, now, cutoff, cutoff, cutoff, maxAttempts)),
  ]);
  return results.every(({ results: rows }) => rows.length === 1);
}
