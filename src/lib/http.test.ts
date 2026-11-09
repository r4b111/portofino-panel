import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { handleError } from './http';
import type { AppEnv } from './http';

it('correlaciona la respuesta 500 con el mensaje y el stack registrados', async () => {
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.get('/pedidos/:token', () => {
    throw new Error('D1 no devolvió el número del pedido');
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const response = await app.request('/pedidos/token-privado');
    const requestId = response.headers.get('X-Request-Id');
    expect(response.status).toBe(500);
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(await response.json()).toEqual({
      error: { code: 'internal_error', message: 'Error interno' },
      requestId,
    });
    expect(log).toHaveBeenCalledWith('D1 no devolvió el número del pedido', {
      requestId,
      path: '/pedidos/:token',
      stack: expect.stringMatching(/at <origen>:\d+:\d+/),
    });
  } finally {
    log.mockRestore();
  }
});

it('omite los datos que llegan en un mensaje de error desconocido', async () => {
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.get('/pedidos/:token', () => {
    throw new Error('Fallo para cliente@example.com');
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const response = await app.request('/pedidos/token-privado?email=cliente@example.com');
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledWith('Error no controlado', expect.any(Object));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/cliente@example\.com|token-privado/);
  } finally {
    log.mockRestore();
  }
});
