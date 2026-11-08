import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { loginAgent, requireAgent, requireRole } from '../lib/auth';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/http';
import { findAdminOrder, transitionOrder } from '../lib/orders/service';
import { orderStatuses } from '../lib/orders/state';

export const adminRoutes = new Hono<AppEnv>();
const orderNumber = z.string().regex(/^[1-9][0-9]*$/).transform(Number)
  .refine(Number.isSafeInteger);
const credentials = z.object({
  email: z.string().trim().max(254).email(),
  password: z.string().min(1).max(256),
});
const transition = z.object({ status: z.enum(orderStatuses) });
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
  const input = credentials.safeParse(await readJson(context));
  if (!input.success) throw new HttpError(400, 'invalid_login', 'Revisa el correo y la contraseña');
  return context.json(await loginAgent(context, input.data.email, input.data.password));
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
  if (!input.success) throw new HttpError(400, 'invalid_status', 'Estado inválido');
  context.set('targetStatus', input.data.status);
  if (input.data.status === 'cancelled') return ownerOnly(context, next);
  await next();
}, async (context) => {
  const number = orderNumber.safeParse(context.req.param('number'));
  if (!number.success) throw new HttpError(400, 'invalid_number', 'Número de pedido inválido');
  const order = await transitionOrder(
    context.env, number.data, context.get('targetStatus'), context.get('agent').id,
  );
  return context.json({ order });
});
