import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/http';
import { findAdminOrder } from '../lib/orders/service';
import { hashTrackingToken } from '../lib/tokens';

export const adminRoutes = new Hono<AppEnv>();
const orderNumber = z.string().regex(/^[1-9][0-9]*$/).transform(Number)
  .refine(Number.isSafeInteger);

async function sameToken(received: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    hashTrackingToken(received),
    hashTrackingToken(expected),
  ]);
  // Both SHA-256 digests have 64 hex characters. Compare every position.
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

adminRoutes.use('*', async (context, next) => {
  const expected = context.env.ADMIN_TOKEN;
  if (!expected || expected.length < 32) {
    throw new HttpError(503, 'admin_unavailable', 'Acceso administrativo sin configurar');
  }
  const authorization = context.req.header('Authorization');
  if (!authorization?.startsWith('Bearer ') || !await sameToken(authorization.slice(7), expected)) {
    throw new HttpError(401, 'unauthorized', 'Acceso administrativo requerido');
  }
  await next();
});

adminRoutes.get('/orders/:number', async (context) => {
  const number = orderNumber.safeParse(context.req.param('number'));
  if (!number.success) throw new HttpError(400, 'invalid_number', 'Número de pedido inválido');
  const order = await findAdminOrder(context.env.DB, number.data);
  if (!order) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  return context.json({ order });
});
