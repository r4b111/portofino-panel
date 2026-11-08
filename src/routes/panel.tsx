import { Hono } from 'hono';
import type { Context } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loginAgent, requireAgent, requireRole } from '../lib/auth';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/http';
import { findPanelOrder, listPanelOrders, panelPageSize, transitionOrder } from '../lib/orders/service';
import { orderStatuses } from '../lib/orders/state';
import { loginPage, orderDetail, orderList, panelError } from '../views/panel';

export const panelRoutes = new Hono<AppEnv>();
const sameOriginForm = csrf();
const ownerOnly = requireRole('owner');
const credentials = z.object({
  email: z.string().trim().max(254).email(),
  password: z.string().min(1).max(256),
});
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/)
  .transform(Number).refine(Number.isSafeInteger);
const filters = z.object({
  estado: z.union([z.enum(orderStatuses), z.literal('')]).optional(),
  pagina: positiveInteger.refine((page) => page <= Math.floor(Number.MAX_SAFE_INTEGER / panelPageSize)).optional(),
});
const transitionForm = z.object({
  status: z.enum(orderStatuses),
  expectedVersion: positiveInteger,
});
const orderId = z.string().min(1).max(128);

async function formBody(context: Context<AppEnv>) {
  const type = context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    throw new HttpError(400, 'invalid_form', 'Envía los datos del formulario');
  }
  return context.req.parseBody();
}

panelRoutes.onError((error, context) => {
  if (error instanceof HttpError) {
    if (error.status === 401) return context.redirect('/login', 303);
    return context.html(panelError(error.message), error.status);
  }
  if (error instanceof HTTPException && error.status === 403) {
    return context.html(panelError('Origen no permitido'), 403);
  }
  return context.html(panelError('Error interno'), 500);
});

panelRoutes.get('/login', (context) => context.html(loginPage()));

panelRoutes.post('/login', sameOriginForm, async (context) => {
  const fields = await formBody(context);
  const input = credentials.safeParse(fields);
  if (!input.success) {
    const email = typeof fields.email === 'string' ? fields.email.slice(0, 254) : '';
    return context.html(loginPage(email, 'Revisa el correo y la contraseña'), 400);
  }
  try {
    await loginAgent(context, input.data.email, input.data.password);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      return context.html(loginPage(input.data.email, error.message), 401);
    }
    throw error;
  }
  return context.redirect('/pedidos', 303);
});

panelRoutes.get('/pedidos', requireAgent, async (context) => {
  const input = filters.safeParse(context.req.query());
  if (!input.success) throw new HttpError(400, 'invalid_filter', 'Filtro o página inválidos');
  const page = input.data.pagina ?? 1;
  const status = input.data.estado || undefined;
  return context.html(orderList(await listPanelOrders(context.env.DB, page, status), page, status));
});

panelRoutes.get('/pedidos/:id', requireAgent, async (context) => {
  const id = orderId.safeParse(context.req.param('id'));
  if (!id.success) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  const detail = await findPanelOrder(context.env.DB, id.data);
  return context.html(orderDetail(detail, context.get('agent').role));
});

panelRoutes.post('/pedidos/:id', requireAgent, sameOriginForm, async (context, next) => {
  const input = transitionForm.safeParse(await formBody(context));
  if (!input.success) throw new HttpError(400, 'invalid_transition_form', 'Revisa el estado y la versión');
  context.set('transitionDraft', input.data);
  if (input.data.status === 'cancelled') return ownerOnly(context, next);
  await next();
}, async (context) => {
  const id = orderId.safeParse(context.req.param('id'));
  if (!id.success) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  const draft = context.get('transitionDraft');
  const agent = context.get('agent');
  try {
    await transitionOrder(context.env, id.data, draft.status, agent.id, draft.expectedVersion);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    const detail = await findPanelOrder(context.env.DB, id.data);
    return context.html(orderDetail(detail, agent.role, { draft, message: error.message }), 409);
  }
  return context.redirect('/pedidos/' + encodeURIComponent(id.data), 303);
});

panelRoutes.post('/api/pedidos/:id/realtime-token', requireAgent, async (context) => {
  const origin = context.req.header('Origin');
  if (origin && origin !== new URL(context.req.url).origin) {
    throw new HttpError(403, 'forbidden_origin', 'Origen no permitido');
  }
  const id = orderId.safeParse(context.req.param('id'));
  if (!id.success) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  const order = await context.env.DB.prepare(
    'SELECT expires_at FROM orders WHERE id = ? AND anonymized_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  ).bind(id.data, Date.now()).first<{ expires_at: number | null }>();
  if (!order) throw new HttpError(404, 'order_not_found', 'Pedido no disponible');
  const agent = context.get('agent');
  return context.json(await context.env.ORDER_ROOMS.getByName(id.data).issueTicket(
    id.data, 'agent', 'agent:' + agent.id, Math.min(order.expires_at ?? Infinity, agent.expiresAt),
  ));
});
