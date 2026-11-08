import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { loginAgent, loginCredentials, requireAgent, requireRole } from '../lib/auth';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/http';
import { confirmOrderShipping, findAdminOrder, transitionOrder } from '../lib/orders/service';
import { orderStatuses } from '../lib/orders/state';

export const adminRoutes = new Hono<AppEnv>();
const orderNumber = z.string().regex(/^[1-9][0-9]*$/).transform(Number)
  .refine(Number.isSafeInteger);
const transition = z.object({
  status: z.enum(orderStatuses),
  expectedVersion: z.number().int().safe().positive(),
});
const shipping = z.object({
  carrier: z.string().trim().min(1).max(100),
  shippingCost: z.number().int().safe().nonnegative(),
  shippingEtaDays: z.number().int().safe().nonnegative(),
}).strict();
const ownerOnly = requireRole('owner');

async function readJson(context: Context<AppEnv>): Promise<unknown> {
  const origin = context.req.header('Origin');
  if (origin && origin !== new URL(context.req.url).origin) {
    throw new HttpError(403, 'forbidden_origin', 'Origen no permitido');
  }
  if (context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(400, 'invalid_json', 'Envía un cuerpo JSON');
  }
  return context.req.json().catch(() => null);
}

adminRoutes.post('/login', async (context) => {
  const input = loginCredentials.safeParse(await readJson(context));
  if (!input.success) throw new HttpError(400, 'invalid_login', 'Revisa el correo y la contraseña');
  return context.json(await loginAgent(context, input.data.email, input.data.password, input.data.totp));
});

adminRoutes.get('/orders/:number', requireAgent, async (context) => {
  const number = orderNumber.safeParse(context.req.param('number'));
  if (!number.success) throw new HttpError(400, 'invalid_number', 'Número de pedido inválido');
  const order = await findAdminOrder(context.env.DB, number.data);
  if (!order) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  return context.json({ order });
});

adminRoutes.patch('/orders/:number/status', requireAgent, async (context, next) => {
  const input = transition.safeParse(await readJson(context));
  if (!input.success) throw new HttpError(400, 'invalid_status', 'Revisa el estado y la versión del pedido');
  context.set('transitionDraft', input.data);
  if (input.data.status === 'cancelled') return ownerOnly(context, next);
  await next();
}, async (context) => {
  const number = orderNumber.safeParse(context.req.param('number'));
  if (!number.success) throw new HttpError(400, 'invalid_number', 'Número de pedido inválido');
  const { status, expectedVersion } = context.get('transitionDraft');
  const order = await transitionOrder(context.env, number.data, status, context.get('agent').id, expectedVersion);
  return context.json({ order });
});

adminRoutes.patch('/orders/:number/shipping', requireAgent, async (context) => {
  const number = orderNumber.safeParse(context.req.param('number'));
  if (!number.success) throw new HttpError(400, 'invalid_number', 'Número de pedido inválido');
  const input = shipping.safeParse(await readJson(context));
  if (!input.success) throw new HttpError(400, 'invalid_shipping', 'Revisa la transportadora, el costo y el plazo');
  const order = await confirmOrderShipping(context.env, number.data, context.get('agent').id, input.data);
  return context.json({ order });
});
