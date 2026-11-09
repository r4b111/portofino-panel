const windowMs = 60_000;
const limit = 10;

export async function reserveCustomerMessage(database: D1Database, tokenHash: string) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const [reservation, window] = await database.batch<{ window_start: number }>([
    database.prepare(`
      INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
        window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
      WHERE window_start <= ? OR count < ?
      RETURNING window_start
    `).bind(tokenHash, now, cutoff, cutoff, cutoff, limit),
    database.prepare('SELECT window_start FROM rate_limits WHERE key = ?').bind(tokenHash),
  ]);
  if (reservation?.results.length) return { allowed: true as const };
  const start = window?.results[0]?.window_start;
  if (start === undefined) throw new Error('Falta la ventana de mensajes');
  return { allowed: false as const, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
}
