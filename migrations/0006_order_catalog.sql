CREATE TABLE order_catalog (
  product_id TEXT PRIMARY KEY NOT NULL,
  product_name TEXT NOT NULL,
  presentation TEXT NOT NULL,
  unit_amount INTEGER NOT NULL CHECK (typeof(unit_amount) = 'integer' AND unit_amount BETWEEN 0 AND 9007199254740991)
);
