import type { ErrorHandler } from 'hono';
import type { OrderRoom } from '../durable/order-room';
import { HttpError } from './errors';
import type { OrderStatus } from './orders/state';

export interface TransitionDraft {
  status: OrderStatus;
  expectedVersion: number;
}

export interface AppEnv {
  Bindings: {
    DB: D1Database;
    ORDER_ROOMS: DurableObjectNamespace<OrderRoom>;
    STOREFRONT_ORIGIN?: string;
    DATA_SECRET?: string;
    ADMIN_SESSION_SECRET?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    TELEGRAM_BOT_TOKEN?: string;
  };
  Variables: {
    agent: { id: string; role: 'owner' | 'agent'; expiresAt: number };
    transitionDraft: TransitionDraft;
  };
}

function logText(value: string, params: Record<string, string>): string {
  for (const param of Object.values(params)) {
    if (param) value = value.replaceAll(param, '[omitido]');
  }
  return value
    .replace(/[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/g, '[correo omitido]')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 200);
}

export const handleError: ErrorHandler<AppEnv> = (error, context) => {
  if (error instanceof HttpError) {
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  const requestId = crypto.randomUUID();
  const params = context.req.param();
  const name = logText(error.name, params);
  const message = logText(error.message, params);
  // Stack headers, function names and source URLs can contain request data.
  const stack = (error.stack ?? '').split('\n').slice(1).flatMap((frame) => {
    const location = frame.match(/^\s+at .*:(\d+):(\d+)\)?$/);
    return location ? [`    at <origen>:${location[1]}:${location[2]}`] : [];
  }).join('\n');
  // Use the registered template when the raw path contains parameter values.
  const route = context.req.routePath;
  const path = context.req.path === route ? context.req.path : route;
  console.error(message, { requestId, name, path, stack });

  context.header('X-Request-Id', requestId);
  return context.json({
    error: { code: 'internal_error', message: 'Error interno' },
    requestId,
  }, 500);
};
