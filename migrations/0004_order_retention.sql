-- The initial migration declares these columns NOT NULL. Copy their values into
-- nullable replacements before dropping the originals. Keep the orders table
-- itself so its foreign keys, indexes, and dependent rows are preserved.
ALTER TABLE orders ADD COLUMN buyer_name_nullable TEXT;
ALTER TABLE orders ADD COLUMN buyer_email_enc_nullable TEXT;
ALTER TABLE orders ADD COLUMN buyer_phone_enc_nullable TEXT;
ALTER TABLE orders ADD COLUMN ship_address_enc_nullable TEXT;

UPDATE orders SET
  buyer_name_nullable = buyer_name,
  buyer_email_enc_nullable = buyer_email_enc,
  buyer_phone_enc_nullable = buyer_phone_enc,
  ship_address_enc_nullable = ship_address_enc;

ALTER TABLE orders DROP COLUMN buyer_name;
ALTER TABLE orders DROP COLUMN buyer_email_enc;
ALTER TABLE orders DROP COLUMN buyer_phone_enc;
ALTER TABLE orders DROP COLUMN ship_address_enc;
ALTER TABLE orders RENAME COLUMN buyer_name_nullable TO buyer_name;
ALTER TABLE orders RENAME COLUMN buyer_email_enc_nullable TO buyer_email_enc;
ALTER TABLE orders RENAME COLUMN buyer_phone_enc_nullable TO buyer_phone_enc;
ALTER TABLE orders RENAME COLUMN ship_address_enc_nullable TO ship_address_enc;

CREATE TRIGGER orders_record_anonymization
AFTER UPDATE OF anonymized_at ON orders
WHEN OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL
BEGIN
  INSERT INTO order_events (id, order_id, seq, actor_type, type, from_status, to_status, created_at)
  VALUES (
    lower(hex(randomblob(16))), NEW.id,
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM order_events WHERE order_id = NEW.id),
    'system', 'anonymized', OLD.status, NEW.status, NEW.anonymized_at
  );
END;
