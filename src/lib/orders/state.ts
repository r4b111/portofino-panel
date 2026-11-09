export const orderStatuses = [
  'pending_confirmation',
  'confirmed',
  'packing',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
  'expired',
] as const;

export const paymentStatuses = [
  'unpaid', 'paid', 'cod_pending', 'cod_collected', 'refunded',
] as const;

export const actorTypes = ['customer', 'agent', 'system', 'bot'] as const;

export const orderEventTypes = [
  'created', 'status_changed', 'payment_changed', 'items_changed', 'note', 'anonymized',
] as const;
