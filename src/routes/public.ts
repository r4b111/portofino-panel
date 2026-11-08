import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/http';
import { findTrackingOrder } from '../lib/orders/service';

export const publicRoutes = new Hono<AppEnv>();
const trackingToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

publicRoutes.get('/health', (context) => context.json({ ok: true }));

publicRoutes.get('/orders/tracking', async (context) => {
  const token = trackingToken.safeParse(context.req.header('X-Tracking-Token'));
  if (!token.success) throw new HttpError(400, 'invalid_token', 'Token de seguimiento inválido');
  const order = await findTrackingOrder(context.env.DB, token.data);
  if (!order) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  return context.json({ order });
});
