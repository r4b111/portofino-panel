const batchSize = 100;

export async function expireOrders(database: D1Database, cutoff: number): Promise<void> {
  const batch = database.prepare(`
    UPDATE orders SET
      status = 'expired',
      buyer_name = NULL,
      buyer_email_enc = NULL,
      buyer_phone_enc = NULL,
      ship_address_enc = NULL,
      ship_notes = NULL,
      anonymized_at = ?,
      updated_at = MAX(updated_at, ?),
      version = version + 1
    WHERE id IN (
      SELECT id FROM orders
      WHERE expires_at <= ? AND anonymized_at IS NULL
        AND status IN ('pending_confirmation', 'confirmed', 'packing', 'shipped')
      ORDER BY expires_at, id
      LIMIT ?
    )
    RETURNING id
  `).bind(cutoff, cutoff, cutoff, batchSize);

  // The migration's trigger records each event in the same write as the anonymization.
  while ((await batch.all<{ id: string }>()).results.length === batchSize) {
    // Continue until the last batch is smaller than the limit.
  }
}
