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

export const handleError: ErrorHandler<AppEnv> = (error, context) => {
  if (error instanceof HttpError) {
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  return context.json({
    error: { code: 'internal_error', message: 'Error interno' },
  }, 500);
};
