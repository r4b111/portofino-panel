import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { orders } from '../../db/schema';
import { HttpError } from '../errors';
import { allowedTransitions } from './state';
import type { OrderStatus } from './state';

import { hashTrackingToken } from '../tokens';

const trackingFields = {
  number: orders.number,
  status: orders.status,
  paymentStatus: orders.paymentStatus,
  currency: orders.currency,
  carrier: orders.carrier,
  shippingEtaDays: orders.shippingEtaDays,
  updatedAt: orders.updatedAt,
};

export async function findTrackingOrder(database: D1Database, token: string) {
  const hash = await hashTrackingToken(token);
  const now = Date.now();
  const [order] = await drizzle(database).select(trackingFields).from(orders).where(and(
    eq(orders.trackingTokenHash, hash),
    or(isNull(orders.tokenExpiresAt), gt(orders.tokenExpiresAt, now)),
    or(isNull(orders.expiresAt), gt(orders.expiresAt, now)),
    isNull(orders.anonymizedAt),
  )).limit(1);
  return order;
}

export async function findAdminOrder(database: D1Database, number: number) {
  const [order] = await drizzle(database).select({
    ...trackingFields,
    subtotalAmount: orders.subtotalAmount,
    shippingCost: orders.shippingCost,
    totalAmount: orders.totalAmount,
    version: orders.version,
  }).from(orders).where(eq(orders.number, number)).limit(1);
  return order;
}

export async function transitionOrder(
  database: D1Database, number: number, to: OrderStatus, adminId: string,
) {
  const current = await database.prepare(
    'SELECT id, status, version FROM orders WHERE number = ?',
  ).bind(number).first<{ id: string; status: OrderStatus; version: number }>();
  if (!current) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  if (!allowedTransitions[current.status].includes(to)) {
    throw new HttpError(409, 'invalid_transition', 'La transición no está permitida');
  }

  const now = Date.now();
  const [updated] = await database.batch([
    database.prepare(`
      UPDATE orders SET status = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status = ?
    `).bind(to, now, current.id, current.version, current.status),
    // The prior UPDATE and audit INSERT share the D1 transaction and connection.
    database.prepare(`
      INSERT INTO audit_log (id, admin_id, action, entity, entity_id, from_status, to_status, created_at)
      SELECT ?, ?, 'status_changed', 'order', ?, ?, ?, ? WHERE changes() = 1
    `).bind(crypto.randomUUID(), adminId, current.id, current.status, to, now),
  ]);
  if (updated?.meta.changes !== 1) {
    throw new HttpError(409, 'order_changed', 'El pedido cambió, vuelve a consultarlo');
  }
  return { number, status: to, version: current.version + 1, updatedAt: now };
}
