import { Hono } from 'hono';
import { trackingTokenFormat } from '../durable/order-room';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/http';
import { findRealtimeOrder, findTrackingOrder } from '../lib/orders/service';
import { trackingPage } from '../views/order-chat';

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/seguimiento', (context) => context.html(trackingPage()));

publicRoutes.get('/health', (context) => context.json({ ok: true }));

publicRoutes.get('/orders/tracking', async (context) => {
  const token = trackingTokenFormat.safeParse(context.req.header('X-Tracking-Token'));
  if (!token.success) throw new HttpError(400, 'invalid_token', 'Token de seguimiento inválido');
  const order = await findTrackingOrder(context.env.DB, token.data);
  if (!order) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  return context.json({ order });
});

publicRoutes.post('/api/orders/realtime-token', async (context) => {
  const token = trackingTokenFormat.safeParse(context.req.header('X-Tracking-Token'));
  if (!token.success) throw new HttpError(401, 'invalid_token', 'Token de seguimiento inválido');
  const order = await findRealtimeOrder(context.env.DB, token.data);
  if (!order) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  const accessEndsAt = Math.min(order.tokenExpiresAt ?? Infinity, order.expiresAt ?? Infinity);
  return context.json(await context.env.ORDER_ROOMS.getByName(order.id).issueTicket(
    order.id, 'customer', 'customer', Number.isFinite(accessEndsAt) ? accessEndsAt : undefined,
  ));
});

publicRoutes.get('/api/orders/:id/realtime', (context) => {
  const origin = context.req.header('Origin');
  if (origin && origin !== new URL(context.req.url).origin) {
    throw new HttpError(403, 'forbidden_origin', 'Origen no permitido');
  }
  const id = context.req.param('id');
  if (!id || id.length > 128) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  return context.env.ORDER_ROOMS.getByName(id).fetch(context.req.raw);
});
