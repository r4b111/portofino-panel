CREATE TRIGGER orders_require_shipping_cost_on_insert
BEFORE INSERT ON orders
WHEN NEW.total_amount IS NOT NULL AND NEW.shipping_cost IS NULL
BEGIN
  SELECT RAISE(ABORT, 'shipping_cost required for total_amount');
END;

CREATE TRIGGER orders_require_shipping_cost_on_update
BEFORE UPDATE OF total_amount, shipping_cost ON orders
WHEN NEW.total_amount IS NOT NULL AND NEW.shipping_cost IS NULL
BEGIN
  SELECT RAISE(ABORT, 'shipping_cost required for total_amount');
END;
