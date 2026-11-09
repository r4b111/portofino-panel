/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../index';
import { decrypt } from '../lib/crypto';
import type { AppEnv } from '../lib/http';
import { hashTrackingToken } from '../lib/tokens';

const testEnv = env as AppEnv['Bindings'] & { TEST_MIGRATIONS: D1Migration[] };
const secret = 'secreto exclusivo de pruebas';
const bindings = { ...testEnv, DATA_SECRET: secret };
const db = bindings.DB;
const item = { productId: 'perfume-1', qty: 2, unitAmount: 1 };
const payload = {
  name: 'Cliente de prueba',
  email: 'cliente@example.test',
  phone: '3000000000',
  address: 'Dirección de prueba',
  city: 'Medellín',
  items: [item],
};

function postOrder(body: unknown) {
  return app.request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, bindings);
}

beforeAll(async () => {
  await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
  await db.prepare(
    'INSERT INTO order_catalog (product_id, product_name, presentation, unit_amount) VALUES (?, ?, ?, ?)',
  ).bind(item.productId, 'Perfume de prueba', '50 ml', 45000).run();
});

beforeEach(async () => {
  await db.prepare('DELETE FROM orders').run();
});

describe('POST /api/orders', () => {
  it('ignora importes manipulados, cifra los datos y guarda el evento created', async () => {
    const startedAt = Date.now();
    const response = await postOrder({
      ...payload,
      subtotalAmount: 1,
      totalAmount: 1,
      items: [{ ...item, lineAmount: 1 }],
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const created = await response.json<{ number: number; token: string; expiresAt: number }>();
    expect(created).toEqual({
      number: expect.any(Number),
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: expect.any(Number),
    });
    const lifetime = 72 * 60 * 60 * 1000;
    expect(created.expiresAt).toBeGreaterThanOrEqual(startedAt + lifetime);
    expect(created.expiresAt).toBeLessThanOrEqual(Date.now() + lifetime);

    const order = await db.prepare('SELECT * FROM orders WHERE number = ?').bind(created.number)
      .first<{ id: string; buyer_email_enc: string; buyer_phone_enc: string; ship_address_enc: string }>();
    expect(order).toMatchObject({
      subtotal_amount: 90000,
      total_amount: null,
      tracking_token_hash: await hashTrackingToken(created.token),
      token_expires_at: null,
      ship_city: 'Medellín',
      expires_at: created.expiresAt,
      status: 'pending_confirmation',
    });
    expect(order).not.toBeNull();
    if (!order) throw new Error('Falta el pedido creado');
    for (const [ciphertext, plaintext] of [
      [order.buyer_email_enc, payload.email],
      [order.buyer_phone_enc, payload.phone],
      [order.ship_address_enc, payload.address],
    ] as const) {
      expect(ciphertext).not.toBe(plaintext);
      await expect(decrypt(ciphertext, secret)).resolves.toBe(plaintext);
    }
    expect(await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(order.id).first())
      .toMatchObject({ qty: 2, unit_amount: 45000, line_amount: 90000 });
    expect(await db.prepare('SELECT * FROM order_events WHERE order_id = ?').bind(order.id).first())
      .toMatchObject({ seq: 1, type: 'created', actor_type: 'customer' });

    const tracking = await app.request('/orders/tracking', {
      headers: { 'X-Tracking-Token': created.token },
    }, bindings);
    expect(tracking.status).toBe(200);
    const trackingBody = await tracking.text();
    expect(trackingBody).not.toContain(created.token);
    expect(trackingBody).not.toContain(await hashTrackingToken(created.token));
  });

  it.each([
    { label: 'pedido vacío', items: [] },
    { label: 'qty igual a 0', items: [{ ...item, qty: 0 }] },
    { label: 'qty igual a 100', items: [{ ...item, qty: 100 }] },
    { label: '21 ítems', items: Array.from({ length: 21 }, () => item) },
  ])('rechaza $label antes de escribir', async ({ items }) => {
    const response = await postOrder({ ...payload, items });
    expect(response.status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM orders').first('count')).toBe(0);
  });

  it('rechaza un email inválido antes de escribir', async () => {
    expect((await postOrder({ ...payload, email: 'correo-invalido' })).status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM orders').first('count')).toBe(0);
  });

  it('revierte el pedido y sus ítems si falla la escritura del evento', async () => {
    await db.prepare(`
      CREATE TRIGGER reject_created BEFORE INSERT ON order_events
      BEGIN SELECT RAISE(ABORT, 'error de prueba'); END
    `).run();
    try {
      const response = await postOrder(payload);
      expect(response.status).toBe(500);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM orders').first('count')).toBe(0);
      expect(await db.prepare('SELECT COUNT(*) AS count FROM order_items').first('count')).toBe(0);
    } finally {
      await db.prepare('DROP TRIGGER reject_created').run();
    }
  });
});
