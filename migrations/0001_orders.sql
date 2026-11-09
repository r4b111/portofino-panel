CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  tracking_token_hash TEXT NOT NULL,
  token_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK (status IN ('pending_confirmation','confirmed','packing','shipped','delivered','cancelled','returned','expired')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','cod_pending','cod_collected','refunded')),
  currency TEXT NOT NULL DEFAULT 'COP',
  subtotal_amount INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_amount >= 0),
  shipping_cost INTEGER CHECK (shipping_cost >= 0),
  shipping_eta_days INTEGER,
  carrier TEXT,
  total_amount INTEGER CHECK (total_amount >= 0),
  customer_id TEXT,
  buyer_name TEXT NOT NULL,
  buyer_email_enc TEXT NOT NULL,
  buyer_phone_enc TEXT NOT NULL,
  ship_address_enc TEXT NOT NULL,
  ship_city TEXT,
  ship_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  anonymized_at INTEGER
);
CREATE UNIQUE INDEX orders_token_hash_uq ON orders (tracking_token_hash);
CREATE UNIQUE INDEX orders_number_uq ON orders (number);
CREATE INDEX orders_status_created_idx ON orders (status, created_at);
CREATE INDEX orders_expires_idx ON orders (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id TEXT,
  product_name TEXT NOT NULL,
  presentation TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
  line_amount INTEGER NOT NULL CHECK (line_amount >= 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer','agent','system','bot')),
  actor_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('created','status_changed','payment_changed','items_changed','note','anonymized')),
  from_status TEXT,
  to_status TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);
CREATE UNIQUE INDEX order_events_seq_uq ON order_events (order_id, seq);
