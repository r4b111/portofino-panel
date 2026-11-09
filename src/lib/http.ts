import type { ErrorHandler } from 'hono';
import { HttpError } from './errors';

export interface AppEnv {
  Bindings: {
    DB: D1Database;
    DATA_SECRET?: string;
    ADMIN_TOKEN?: string;
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
