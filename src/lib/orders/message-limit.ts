const windowMs = 60_000;
const limit = 10;

export async function reserveCustomerMessage(database: D1Database, tokenHash: string) {
  const now = Date.now();
  const cutoff = now - windowMs;
  // Keep the start of an active window. A newer start resets the count to one.
  const [reservation, window] = await database.batch<{ count: number; window_start: number }>([
    database.prepare(`
      INSERT INTO rate_limits (key, window_start, count)
      VALUES (?, COALESCE((
        SELECT window_start FROM rate_limits WHERE key = ? AND window_start > ?
      ), ?), 1)
      ON CONFLICT(key) DO UPDATE SET
        window_start = excluded.window_start,
        count = CASE
          WHEN rate_limits.window_start < excluded.window_start THEN excluded.count
          ELSE rate_limits.count + 1
        END
      WHERE rate_limits.window_start < excluded.window_start OR rate_limits.count < ?
      RETURNING count, window_start
    `).bind(tokenHash, tokenHash, cutoff, now, limit),
    database.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(tokenHash),
  ]);
  if (reservation?.results.length) return { allowed: true as const };
  const start = window?.results[0]?.window_start;
  if (start === undefined) throw new Error('Falta la ventana de mensajes');
  return { allowed: false as const, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
}
