import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { auditLog, orderEvents, orderItems, orders } from '../../db/schema';
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
  database: D1Database, identifier: number | string, to: OrderStatus, adminId: string,
  expectedVersion?: number,
) {
  const [current] = await drizzle(database).select({
    id: orders.id, number: orders.number, status: orders.status, version: orders.version,
  }).from(orders).where(typeof identifier === 'number'
    ? eq(orders.number, identifier)
    : eq(orders.id, identifier)).limit(1);
  if (!current) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  if (expectedVersion !== undefined && expectedVersion !== current.version) {
    throw new HttpError(409, 'order_changed', 'Otro agente lo modificó');
  }
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
    throw new HttpError(409, 'order_changed', 'Otro agente lo modificó');
  }
  return { number: current.number, status: to, version: current.version + 1, updatedAt: now };
}

export const panelPageSize = 50;
const panelFields = {
  id: orders.id,
  number: orders.number,
  status: orders.status,
  paymentStatus: orders.paymentStatus,
  buyerName: orders.buyerName,
  currency: orders.currency,
  subtotalAmount: orders.subtotalAmount,
  totalAmount: orders.totalAmount,
  createdAt: orders.createdAt,
};

export async function listPanelOrders(database: D1Database, page: number, status?: OrderStatus) {
  const rows = await drizzle(database).select(panelFields).from(orders)
    .where(status ? eq(orders.status, status) : undefined)
    .orderBy(desc(orders.createdAt), desc(orders.number))
    .limit(panelPageSize + 1).offset((page - 1) * panelPageSize);
  return { rows: rows.slice(0, panelPageSize), hasNext: rows.length > panelPageSize };
}

export async function findPanelOrder(database: D1Database, id: string) {
  const db = drizzle(database);
  const [[order], items, events, audit] = await db.batch([
    db.select({
      ...panelFields, version: orders.version, shipCity: orders.shipCity,
    }).from(orders).where(eq(orders.id, id)).limit(1),
    db.select({
      id: orderItems.id, name: orderItems.productName, presentation: orderItems.presentation,
      qty: orderItems.qty, unitAmount: orderItems.unitAmount, lineAmount: orderItems.lineAmount,
    }).from(orderItems).where(eq(orderItems.orderId, id)).orderBy(asc(orderItems.productName), asc(orderItems.id)),
    db.select({
      id: orderEvents.id, type: orderEvents.type, at: orderEvents.createdAt,
      from: orderEvents.fromStatus, to: orderEvents.toStatus,
    }).from(orderEvents).where(eq(orderEvents.orderId, id)).orderBy(asc(orderEvents.seq)),
    db.select({
      id: auditLog.id, type: auditLog.action, at: auditLog.createdAt,
      from: auditLog.fromStatus, to: auditLog.toStatus,
    }).from(auditLog).where(and(eq(auditLog.entity, 'order'), eq(auditLog.entityId, id))),
  ]);
  if (!order) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  const history = [...events, ...audit].sort((a, b) => a.at - b.at);
  return { order, items, history };
}
