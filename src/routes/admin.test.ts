/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import type { AppEnv } from '../lib/http';
import { hashPassword } from '../lib/passwords';
import { generateTrackingToken, hashTrackingToken } from '../lib/tokens';

const bindings = env as AppEnv['Bindings'] & { TEST_MIGRATIONS: D1Migration[] };
const testBindings = { ...bindings, ADMIN_SESSION_SECRET: 'firma exclusiva de prueba de más de 32 caracteres' };
const db = bindings.DB;
const password = 'contraseña exclusiva de prueba';
const eightHours = 8 * 60 * 60 * 1000;

function jsonRequest(path: string, method: 'POST' | 'PATCH', body: unknown, cookie?: string, ip?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookie) headers.set('Cookie', cookie);
  if (ip) headers.set('CF-Connecting-IP', ip);
  return app.request('https://portofino.example.test' + path, {
    method, headers, body: JSON.stringify(body),
  }, testBindings);
}

async function login(role: 'owner' | 'agent') {
  const response = await jsonRequest('/admin/login', 'POST', {
    email: role + '@example.test', password,
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie');
  expect(cookie).toBeTruthy();
  if (!cookie) throw new Error('Falta la cookie de sesión');
  return { response, cookie, credential: cookie.split(';', 1)[0]! };
}

function changeStatus(status: string, cookie: string, expectedVersion = 1) {
  return jsonRequest('/admin/orders/1/status', 'PATCH', { status, expectedVersion }, cookie);
}

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  const digest = await hashPassword(password);
  await db.batch(['owner', 'agent'].map((role) => db.prepare(
    'INSERT INTO admins (id, email, password_hash, role) VALUES (?, ?, ?, ?)',
  ).bind(role, role + '@example.test', digest, role)));
});

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM audit_log'),
    db.prepare('DELETE FROM rate_limits'),
    db.prepare('DELETE FROM orders'),
    db.prepare(`
      INSERT INTO orders (id, number, tracking_token_hash, buyer_name, buyer_email_enc,
        buyer_phone_enc, ship_address_enc, created_at, updated_at)
      VALUES ('order-1', 1, 'test-hash', 'Cliente ficticio', 'test', 'test', 'test', 1, 1)
    `),
  ]);
});

describe('autenticación y transiciones administrativas', () => {
  it('devuelve 403 al agente que intenta cancelar y registra la cancelación del owner', async () => {
    const agent = await login('agent');
    expect((await changeStatus('cancelled', agent.credential)).status).toBe(403);
    expect(await db.prepare('SELECT status FROM orders').first('status')).toBe('pending_confirmation');
    expect(await db.prepare('SELECT COUNT(*) AS total FROM audit_log').first('total')).toBe(0);

    const owner = await login('owner');
    expect((await changeStatus('cancelled', owner.credential)).status).toBe(200);
    expect(await db.prepare('SELECT status, version FROM orders').first())
      .toEqual({ status: 'cancelled', version: 2 });
    expect(await db.prepare('SELECT * FROM audit_log').first()).toMatchObject({
      admin_id: 'owner', entity_id: 'order-1', action: 'status_changed',
      from_status: 'pending_confirmation', to_status: 'cancelled',
    });
  });

  it('audita una transición permitida del agente y revierte un cambio si falla la auditoría', async () => {
    const agent = await login('agent');
    expect((await changeStatus('confirmed', agent.credential)).status).toBe(200);
    expect(await db.prepare('SELECT admin_id, to_status FROM audit_log').first())
      .toEqual({ admin_id: 'agent', to_status: 'confirmed' });

    await db.prepare(`
      CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'fallo de prueba'); END
    `).run();
    try {
      expect((await changeStatus('packing', agent.credential, 2)).status).toBe(500);
      expect(await db.prepare('SELECT status, version FROM orders').first())
        .toEqual({ status: 'confirmed', version: 2 });
      expect(await db.prepare('SELECT COUNT(*) AS total FROM audit_log').first('total')).toBe(1);
    } finally {
      await db.prepare('DROP TRIGGER reject_audit').run();
    }
  });

  it('exige versión, limpia el vencimiento al confirmar y descarta una versión anterior sin auditar', async () => {
    const { credential } = await login('agent');
    await db.prepare('UPDATE orders SET expires_at = ?').bind(Date.now() + 60_000).run();
    const noVersion = await jsonRequest('/admin/orders/1/status', 'PATCH', { status: 'confirmed' }, credential);
    expect(noVersion.status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS total FROM audit_log').first('total')).toBe(0);
    expect((await changeStatus('confirmed', credential)).status).toBe(200);
    expect(await db.prepare('SELECT status, expires_at, version FROM orders').first())
      .toEqual({ status: 'confirmed', expires_at: null, version: 2 });
    expect((await changeStatus('packing', credential, 1)).status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) AS total FROM audit_log').first('total')).toBe(1);
    expect(await db.prepare('SELECT version FROM orders').first('version')).toBe(2);
  });

  it('exige costo de envío y revierte el total y el estado si falla la auditoría', async () => {
    const { credential } = await login('agent');
    const quote = { carrier: 'Transportadora', shippingCost: 0, shippingEtaDays: 2 };
    const fixShipping = (body: unknown, cookie?: string) =>
      jsonRequest('/admin/orders/1/shipping', 'PATCH', body, cookie);
    const shippingState = () => db.prepare(`
      SELECT status, version, carrier, shipping_cost, shipping_eta_days, total_amount FROM orders
    `).first();
    const token = generateTrackingToken();
    await db.prepare('UPDATE orders SET subtotal_amount = 20000, tracking_token_hash = ?, expires_at = ?')
      .bind(await hashTrackingToken(token), Date.now() + 60_000).run();
    const pending = await shippingState();

    expect((await fixShipping(quote)).status).toBe(401);
    expect((await fixShipping({ carrier: quote.carrier, shippingEtaDays: 2 }, credential)).status).toBe(400);
    expect((await fixShipping({ ...quote, totalAmount: 1 }, credential)).status).toBe(400);
    await expect(db.prepare('UPDATE orders SET total_amount = 1').run()).rejects.toThrow('shipping_cost required');
    expect(await shippingState()).toEqual(pending);

    await db.prepare(`
      CREATE TRIGGER reject_shipping_audit BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'fallo de prueba'); END
    `).run();
    try {
      expect((await fixShipping(quote, credential)).status).toBe(500);
      expect(await shippingState()).toEqual(pending);
    } finally {
      await db.prepare('DROP TRIGGER reject_shipping_audit').run();
    }

    const responses = await Promise.all([fixShipping(quote, credential), fixShipping(quote, credential)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(await shippingState()).toEqual({
      status: 'confirmed', version: 2, carrier: 'Transportadora', shipping_cost: 0,
      shipping_eta_days: 2, total_amount: 20000,
    });
    expect(await db.prepare('SELECT expires_at FROM orders').first('expires_at')).toBeNull();
    const tracking = await app.request('/orders/tracking', {
      headers: { 'X-Tracking-Token': token },
    }, testBindings);
    expect(await tracking.json()).toMatchObject({
      order: { subtotalAmount: 20000, shippingCost: 0, totalAmount: 20000 },
    });
    expect(await db.prepare('SELECT admin_id, from_status, to_status FROM audit_log').all())
      .toMatchObject({ results: [{ admin_id: 'agent', from_status: 'pending_confirmation', to_status: 'confirmed' }] });
  });

  it('rechaza contraseña incorrecta y cookie alterada', async () => {
    const failed = await jsonRequest('/admin/login', 'POST', {
      email: 'owner@example.test', password: 'incorrecta',
    });
    expect(failed.status).toBe(401);
    expect(failed.headers.has('Set-Cookie')).toBe(false);
    const { credential } = await login('owner');
    expect((await changeStatus('confirmed', credential + 'x')).status).toBe(401);
  });

  it('exige TOTP, admite el paso anterior y rechaza reutilizar un código', async () => {
    // RFC 6238 Appendix B gives 94287082 at t=59 for this SHA-1 secret.
    const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    await db.prepare("UPDATE admins SET totp_secret = ? WHERE id = 'agent'").bind(totpSecret).run();
    vi.setSystemTime(new Date(89_000));
    try {
      const credentials = { email: 'agent@example.test', password };
      const authenticate = (totp?: string) => jsonRequest('/admin/login', 'POST', { ...credentials, totp });
      for (const totp of [undefined, '000000']) {
        const rejected = await authenticate(totp);
        expect(rejected.status).toBe(401);
        expect(await rejected.json()).toMatchObject({ error: { code: 'totp_required' } });
        expect(rejected.headers.has('Set-Cookie')).toBe(false);
      }
      const panel = await app.request('https://portofino.example.test/login', {
        method: 'POST',
        headers: { Origin: 'https://portofino.example.test' },
        body: new URLSearchParams(credentials),
      }, testBindings);
      expect(panel.status).toBe(401);
      expect(await panel.text()).toContain('data-error-code="totp_required"');
      const allowed = await authenticate('287082');
      expect(allowed.status).toBe(200);
      const cookie = allowed.headers.get('Set-Cookie')?.split(';')[0];
      if (!cookie) throw new Error('Falta la cookie de sesión');
      const account = await app.request('/admin/orders/1', { headers: { Cookie: cookie } }, testBindings);
      expect(account.status).toBe(200);
      expect((await authenticate('287082')).status).toBe(401);
    } finally {
      vi.useRealTimers();
      await db.prepare("UPDATE admins SET totp_secret = NULL WHERE id = 'agent'").run();
    }
  });

  it.each(['email', 'IP'])('limita al sexto intento por %s aunque la otra clave cambie', async (dimension) => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const email = dimension === 'email' ? (attempt % 2 ? 'AGENT@example.test' : 'agent@example.test')
        : 'intento' + attempt + '@example.test';
      const ip = dimension === 'IP' ? '192.0.2.1' : '192.0.2.' + attempt;
      const response = await jsonRequest('/admin/login', 'POST', { email, password: 'incorrecta' }, undefined, ip);
      expect(response.status).toBe(attempt < 6 ? 401 : 429);
    }
  });

  it('cuenta solo los fallos e incluye los fallos de TOTP en la cuota', async () => {
    const credentials = { email: 'agent@example.test', password };
    const authenticate = (value: string) =>
      jsonRequest('/admin/login', 'POST', { ...credentials, password: value });
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await authenticate('incorrecta')).status).toBe(401);
      expect((await authenticate(password)).status).toBe(200);
    }
    await db.prepare("UPDATE admins SET totp_secret = ? WHERE id = 'agent'")
      .bind('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').run();
    try {
      const fifth = await authenticate(password);
      expect(fifth.status).toBe(401);
      expect(await fifth.json()).toMatchObject({ error: { code: 'totp_required' } });
      expect((await authenticate(password)).status).toBe(429);
    } finally {
      await db.prepare("UPDATE admins SET totp_secret = NULL WHERE id = 'agent'").run();
    }
  });

  it('emite una cookie segura y rechaza su uso al cumplirse ocho horas', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(now);
    try {
      const { response, cookie, credential } = await login('owner');
      expect(cookie).toContain('__Host-admin_session=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Max-Age=28800');
      await expect(response.json()).resolves.toEqual({
        role: 'owner', expiresAt: now.getTime() + eightHours,
      });

      vi.setSystemTime(now.getTime() + eightHours - 1);
      expect((await changeStatus('confirmed', credential)).status).toBe(200);
      vi.setSystemTime(now.getTime() + eightHours);
      expect((await changeStatus('packing', credential)).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});
