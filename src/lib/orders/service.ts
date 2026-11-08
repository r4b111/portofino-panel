import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { orders } from '../../db/schema';
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
