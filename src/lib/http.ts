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

// Only messages defined by the application are safe to log verbatim.
const safeErrorMessages = new Set([
  'D1 no devolvió el número del pedido',
  'Falta la ventana de mensajes',
  'Telegram rechazó el envío',
  'Base64url inválido',
  'DATA_SECRET es obligatorio',
  'Texto cifrado inválido',
  'Telegram sin configurar',
]);

export const handleError: ErrorHandler<AppEnv> = (error, context) => {
  if (error instanceof HttpError) {
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  const requestId = crypto.randomUUID();
  const message = safeErrorMessages.has(error.message) ? error.message : 'Error no controlado';
  // Stack headers, function names and source URLs can contain request data.
  const stack = (error.stack ?? '').split('\n').slice(1).flatMap((frame) => {
    const location = frame.match(/^\s+at .*:(\d+):(\d+)\)?$/);
    return location ? [`    at <origen>:${location[1]}:${location[2]}`] : [];
  }).join('\n');
  // Use the registered template when the raw path contains parameter values.
  const route = context.req.routePath;
  const path = context.req.path === route ? context.req.path : route;
  console.error(message, { requestId, path, stack });

  context.header('X-Request-Id', requestId);
  return context.json({
    error: { code: 'internal_error', message: 'Error interno' },
    requestId,
  }, 500);
};
