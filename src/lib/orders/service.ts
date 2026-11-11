import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { auditLog, orderCatalog, orderEvents, orderItems, orders } from '../../db/schema';
import { encrypt } from '../crypto';
import { HttpError } from '../errors';
import type { AppEnv } from '../http';
import { allowedTransitions } from './state';
import type { OrderStatus, PaymentStatus } from './state';

import { generateTrackingToken, hashTrackingToken } from '../tokens';

const trackingFields = {
  number: orders.number,
  status: orders.status,
  paymentStatus: orders.paymentStatus,
  currency: orders.currency,
  carrier: orders.carrier,
  shippingEtaDays: orders.shippingEtaDays,
  updatedAt: orders.updatedAt,
};

async function trackingCondition(token: string) {
  const hash = await hashTrackingToken(token);
  const now = Date.now();
  return and(
    eq(orders.trackingTokenHash, hash),
    or(isNull(orders.tokenExpiresAt), gt(orders.tokenExpiresAt, now)),
    or(isNull(orders.expiresAt), gt(orders.expiresAt, now)),
    isNull(orders.anonymizedAt),
  );
}

const amountFields = {
  subtotalAmount: orders.subtotalAmount,
  shippingCost: orders.shippingCost,
  totalAmount: orders.totalAmount,
};

export async function findTrackingOrder(database: D1Database, token: string) {
  const [order] = await drizzle(database).select({ ...trackingFields, ...amountFields }).from(orders)
    .where(await trackingCondition(token)).limit(1);
  return order;
}

export async function findRealtimeOrder(database: D1Database, token: string) {
  const hash = await hashTrackingToken(token);
  const [order] = await drizzle(database).select({
    id: orders.id, expiresAt: orders.expiresAt, tokenExpiresAt: orders.tokenExpiresAt,
    tokenHash: orders.trackingTokenHash, anonymizedAt: orders.anonymizedAt, status: orders.status,
  }).from(orders).where(eq(orders.trackingTokenHash, hash)).limit(1);
  if (!order) return { kind: 'missing' as const };
  const accessEndsAt = Math.min(order.tokenExpiresAt ?? Infinity, order.expiresAt ?? Infinity);
  if (order.anonymizedAt !== null || order.status === 'expired' || accessEndsAt <= Date.now()) {
    return { kind: 'expired' as const };
  }
  return { kind: 'active' as const, order, accessEndsAt };
}

export async function findAdminOrder(database: D1Database, number: number) {
  const [order] = await drizzle(database).select({
    ...trackingFields,
    ...amountFields,
    version: orders.version,
  }).from(orders).where(eq(orders.number, number)).limit(1);
  return order;
}

type ShippingQuote = {
  carrier: string;
  shippingCost: number;
  shippingEtaDays: number;
};

export function transitionOrder(
  env: AppEnv['Bindings'], identifier: number | string, to: OrderStatus, adminId: string,
  expectedVersion: number,
) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new HttpError(400, 'invalid_version', 'Se requiere una versión válida del pedido');
  }
  return applyOrderTransition(env, identifier, to, adminId, expectedVersion);
}

export function confirmOrderShipping(
  env: AppEnv['Bindings'], number: number, adminId: string, shipping: ShippingQuote,
) {
  return applyOrderTransition(env, number, 'confirmed', adminId, undefined, shipping);
}

function paymentChanged(
  database: D1Database, orderId: string, actorId: string, from: PaymentStatus, to: PaymentStatus, now: number,
) {
  return database.prepare(`
    INSERT INTO order_events (id, order_id, seq, actor_type, actor_id, type, payload, created_at)
    SELECT ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM order_events WHERE order_id = ?),
      'agent', ?, 'payment_changed', ?, ?
    WHERE changes() = 1
  `).bind(crypto.randomUUID(), orderId, orderId, actorId, JSON.stringify({ from, to }), now);
}

async function publishOrderState(
  env: AppEnv['Bindings'], id: string, state: { status: OrderStatus; version: number },
) {
  try {
    await env.ORDER_ROOMS.getByName(id).publishState(state);
  } catch {
    // D1 already committed. Reconnecting clients receive its authoritative state.
    console.error('No se pudo difundir un cambio de estado de pedido');
  }
}

const allowedPaymentSources: Record<'paid' | 'refunded', readonly PaymentStatus[]> = {
  paid: ['unpaid', 'cod_pending'],
  refunded: ['paid', 'cod_collected'],
};

export function markOrderPaid(
  env: AppEnv['Bindings'], number: number, actor: AppEnv['Variables']['agent'],
) {
  return updateOrderPayment(env, number, actor, 'paid');
}

export function refundOrderPayment(
  env: AppEnv['Bindings'], number: number, actor: AppEnv['Variables']['agent'],
) {
  return updateOrderPayment(env, number, actor, 'refunded');
}

async function updateOrderPayment(
  env: AppEnv['Bindings'], number: number, actor: AppEnv['Variables']['agent'],
  paymentStatus: keyof typeof allowedPaymentSources,
) {
  if (actor.role !== 'owner') throw new HttpError(403, 'forbidden_role', 'Acceso no autorizado');
  const database = env.DB;
  const [order] = await drizzle(database).select({
    id: orders.id, status: orders.status, version: orders.version, paymentStatus: orders.paymentStatus,
  }).from(orders).where(eq(orders.number, number)).limit(1);
  if (!order) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  if (!allowedPaymentSources[paymentStatus].includes(order.paymentStatus)) {
    throw new HttpError(409, 'invalid_payment_transition', paymentStatus === 'refunded'
      ? 'El pago no se puede reembolsar'
      : 'El pedido no se puede marcar como pagado');
  }
  const now = Date.now();
  const [updated] = await database.batch([
    database.prepare(`
      UPDATE orders SET payment_status = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND payment_status = ?
    `).bind(paymentStatus, now, order.id, order.version, order.paymentStatus),
    paymentChanged(database, order.id, actor.id, order.paymentStatus, paymentStatus, now),
  ]);
  if (updated?.meta.changes !== 1) throw new HttpError(409, 'order_changed', 'Otro agente lo modificó');
  const state = { status: order.status, version: order.version + 1 };
  await publishOrderState(env, order.id, state);
  return { number, ...state, paymentStatus, updatedAt: now };
}

async function applyOrderTransition(
  env: AppEnv['Bindings'], identifier: number | string, to: OrderStatus, adminId: string,
  expectedVersion?: number, shipping?: ShippingQuote,
) {
  const database = env.DB;
  const [current] = await drizzle(database).select({
    id: orders.id, number: orders.number, status: orders.status, version: orders.version,
    subtotalAmount: orders.subtotalAmount, currency: orders.currency, paymentStatus: orders.paymentStatus,
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

  const previousPayment = current.paymentStatus;
  if (to === 'delivered' && previousPayment === 'unpaid') {
    throw new HttpError(409, 'unpaid_delivery', 'Registra el pago antes de marcar el pedido como entregado');
  }
  let paymentStatus = previousPayment;
  if (to === 'confirmed' && previousPayment === 'unpaid') paymentStatus = 'cod_pending';
  if (to === 'delivered' && previousPayment === 'cod_pending') paymentStatus = 'cod_collected';

  const now = Date.now();
  const totalAmount = shipping ? current.subtotalAmount + shipping.shippingCost : null;
  if (totalAmount !== null && !Number.isSafeInteger(totalAmount)) {
    throw new HttpError(400, 'invalid_total', 'El total excede el importe permitido');
  }
  const update = shipping
    ? database.prepare(`
        UPDATE orders SET status = ?, payment_status = ?, version = version + 1, updated_at = ?,
          expires_at = NULL, carrier = ?, shipping_cost = ?, shipping_eta_days = ?, total_amount = subtotal_amount + ?
        WHERE id = ? AND version = ? AND status = ? AND payment_status = ? AND subtotal_amount = ?
          AND anonymized_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      `).bind(to, paymentStatus, now, shipping.carrier, shipping.shippingCost, shipping.shippingEtaDays,
        shipping.shippingCost, current.id, current.version, current.status, previousPayment, current.subtotalAmount, now)
    : database.prepare(`
        UPDATE orders SET status = ?, payment_status = ?, version = version + 1, updated_at = ?,
          expires_at = CASE WHEN ? = 'confirmed' THEN NULL ELSE expires_at END
        WHERE id = ? AND version = ? AND status = ? AND payment_status = ?
      `).bind(to, paymentStatus, now, to, current.id, current.version, current.status, previousPayment);
  const [updated] = await database.batch([
    update,
    // Each insert is conditional on the immediately preceding statement changing one row.
    database.prepare(`
      INSERT INTO audit_log (id, admin_id, action, entity, entity_id, from_status, to_status, created_at)
      SELECT ?, ?, 'status_changed', 'order', ?, ?, ?, ? WHERE changes() = 1
    `).bind(crypto.randomUUID(), adminId, current.id, current.status, to, now),
    ...(paymentStatus === previousPayment ? [] : [
      paymentChanged(database, current.id, adminId, previousPayment, paymentStatus, now),
    ]),
  ]);
  if (updated?.meta.changes !== 1) {
    throw new HttpError(409, 'order_changed', 'Otro agente lo modificó');
  }
  const state = { status: to, version: current.version + 1 };
  await publishOrderState(env, current.id, state);
  return {
    number: current.number, ...state, paymentStatus, updatedAt: now,
    ...(shipping && { ...shipping, currency: current.currency, subtotalAmount: current.subtotalAmount, totalAmount }),
  };
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
      ...panelFields, version: orders.version, shipCity: orders.shipCity, anonymizedAt: orders.anonymizedAt,
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

interface CreateOrderInput {
  name: string;
  email: string;
  phone: string;
  address: string;
  city?: string | undefined;
  items: { productId: string; qty: number }[];
}

const orderLifetimeMs = 72 * 60 * 60 * 1000;
const maxOrderAttempts = 3;
const orderNumberCollision = /\borders_number_uq\b|UNIQUE constraint failed: orders\.number\b(?!,)/;

function isOrderNumberCollision(error: unknown): boolean {
  if (typeof error === 'string') return orderNumberCollision.test(error);
  if (!(error instanceof Error)) return false;
  return orderNumberCollision.test(error.message)
    || (error.cause !== error && isOrderNumberCollision(error.cause));
}

export async function createOrder(database: D1Database, secret: string | undefined, input: CreateOrderInput) {
  if (!secret?.trim()) {
    throw new HttpError(503, 'orders_unavailable', 'El alta de pedidos no está disponible');
  }

  const db = drizzle(database);
  const productIds = [...new Set(input.items.map(({ productId }) => productId))];
  const catalog = await db.select().from(orderCatalog)
    .where(inArray(orderCatalog.productId, productIds));
  const products = new Map(catalog.map((product) => [product.productId, product]));
  let subtotalAmount = 0;

  const items = input.items.map(({ productId, qty }) => {
    const product = products.get(productId);
    if (!product) {
      throw new HttpError(400, 'unknown_product', 'Uno de los productos no está disponible');
    }
    const lineAmount = product.unitAmount * qty;
    subtotalAmount += lineAmount;
    if (!Number.isSafeInteger(lineAmount) || !Number.isSafeInteger(subtotalAmount)) {
      throw new HttpError(400, 'invalid_amount', 'El importe del pedido supera el máximo permitido');
    }
    return { ...product, qty, lineAmount };
  });

  const token = generateTrackingToken();
  const [trackingTokenHash, buyerEmailEnc, buyerPhoneEnc, shipAddressEnc] = await Promise.all([
    hashTrackingToken(token),
    encrypt(input.email, secret),
    encrypt(input.phone, secret),
    encrypt(input.address, secret),
  ]);

  const now = Date.now();
  const expiresAt = now + orderLifetimeMs;
  for (let attempt = 1; ; attempt++) {
    const orderId = crypto.randomUUID();
    const insertOrder = db.insert(orders).values({
      id: orderId,
      number: sql<number>`(SELECT COALESCE(MAX(number), 0) + 1 FROM orders)`,
      trackingTokenHash,
      subtotalAmount,
      buyerName: input.name,
      buyerEmailEnc,
      buyerPhoneEnc,
      shipAddressEnc,
      shipCity: input.city ?? null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    }).returning({ number: orders.number });

    try {
      const [inserted] = await db.batch([
        insertOrder,
        ...items.map((item) => db.insert(orderItems).values({ ...item, id: crypto.randomUUID(), orderId })),
        db.insert(orderEvents).values({
          id: crypto.randomUUID(),
          orderId,
          seq: 1,
          actorType: 'customer',
          type: 'created',
          toStatus: 'pending_confirmation',
          createdAt: now,
        }),
      ]);
      const [order] = inserted;
      if (!order) throw new Error('D1 no devolvió el número del pedido');
      return { number: order.number, token, expiresAt };
    } catch (error) {
      if (attempt >= maxOrderAttempts || !isOrderNumberCollision(error)) throw error;
    }
  }
}
