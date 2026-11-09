import { Hono } from 'hono';
import type { Context } from 'hono';
import { etag, RETAINED_304_HEADERS } from 'hono/etag';
import { z } from 'zod';
import { customerMessageSchema, trackingTokenFormat } from '../durable/order-room';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/http';
import { createOrder, findRealtimeOrder, findTrackingOrder } from '../lib/orders/service';
import { trackingPage } from '../views/order-chat';
import { widgetScript } from '../views/widget';

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/seguimiento', (context) => context.html(trackingPage()));

const widgetEtag = etag({
  retainedHeaders: [...RETAINED_304_HEADERS, 'access-control-allow-origin', 'x-frame-options', 'x-content-type-options'],
});

publicRoutes.get('/pf-chat.js', widgetEtag, (context) => context.body(widgetScript, 200, {
  'Content-Type': 'text/javascript; charset=UTF-8',
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
}));

function frameAncestor(value: string | undefined): string {
  if (!value || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?\/?$/i.test(value)) return "'none'";
  try {
    return new URL(value).origin;
  } catch {
    return "'none'";
  }
}

publicRoutes.get('/widgets/chat', (context) => {
  context.header('Content-Security-Policy', 'frame-ancestors ' + frameAncestor(context.env.STOREFRONT_ORIGIN));
  return context.html(trackingPage(true));
});

publicRoutes.get('/health', (context) => context.json({ ok: true }));

publicRoutes.get('/orders/tracking', async (context) => {
  const token = trackingTokenFormat.safeParse(context.req.header('X-Tracking-Token'));
  if (!token.success) throw new HttpError(400, 'invalid_token', 'Token de seguimiento inválido');
  const order = await findTrackingOrder(context.env.DB, token.data);
  if (!order) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  return context.json({ order });
});

async function requireTrackingOrder(context: Context<AppEnv>) {
  const token = trackingTokenFormat.safeParse(context.req.header('X-Tracking-Token'));
  if (!token.success) throw new HttpError(401, 'invalid_token', 'Token de seguimiento inválido');
  const result = await findRealtimeOrder(context.env.DB, token.data);
  if (result.kind === 'missing') throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  if (result.kind === 'expired') throw new HttpError(410, 'token_expired', 'El enlace caducó');
  return result;
}

publicRoutes.post('/api/orders/realtime-token', async (context) => {
  const { order, accessEndsAt } = await requireTrackingOrder(context);
  return context.json(await context.env.ORDER_ROOMS.getByName(order.id).issueTicket(
    order.id, 'customer', 'customer:' + order.tokenHash, Number.isFinite(accessEndsAt) ? accessEndsAt : undefined,
  ));
});

publicRoutes.post('/api/orders/messages', async (context) => {
  const { order } = await requireTrackingOrder(context);
  const message = customerMessageSchema.safeParse(await context.req.json().catch(() => null));
  if (!message.success) throw new HttpError(400, 'invalid_message', 'Mensaje inválido');
  const result = await context.env.ORDER_ROOMS.getByName(order.id).postCustomerMessage(order.tokenHash, message.data);
  if (result.status === 429) {
    context.header('Retry-After', String(result.retryAfter));
    return context.json({ error: { code: 'rate_limited', message: 'Límite de mensajes alcanzado' } }, 429);
  }
  return context.json({ ok: true }, result.status);
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

const newOrder = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(254).email(),
  phone: z.string().trim().min(1).max(40),
  address: z.string().trim().min(1).max(500),
  city: z.string().trim().min(1).max(120).optional(),
  items: z.array(z.object({
    productId: z.string().trim().min(1).max(128),
    qty: z.number().int().min(1).max(99),
    unitAmount: z.number().int().safe().nonnegative(),
  })).min(1).max(20),
});

publicRoutes.post('/api/orders', async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  const input = newOrder.safeParse(body);
  if (!input.success) {
    throw new HttpError(400, 'invalid_order', 'Revisa los datos y los ítems del pedido');
  }

  const order = await createOrder(context.env.DB, context.env.DATA_SECRET, input.data);
  return context.json(order, 201);
});
