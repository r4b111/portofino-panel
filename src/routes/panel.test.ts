/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../index';
import type { AppEnv } from '../lib/http';
import { hashPassword } from '../lib/passwords';

const bindings = env as AppEnv['Bindings'] & { TEST_MIGRATIONS: D1Migration[] };
const testBindings = { ...bindings, ADMIN_SESSION_SECRET: 'firma de prueba exclusiva para el panel' };
const db = bindings.DB;
const password = 'contraseña de prueba';
const origin = 'https://portofino.example.test';
const detailPath = '/pedidos/order-1';

async function get(path: string, cookie?: string) {
  return app.request(origin + path, { headers: cookie ? { Cookie: cookie } : {} }, testBindings);
}

function post(path: string, fields: Record<string, string>, cookie?: string) {
  const headers = new Headers({ Origin: origin });
  if (cookie) headers.set('Cookie', cookie);
  return app.request(origin + path, {
    method: 'POST', headers, body: new URLSearchParams(fields),
  }, testBindings);
}

async function login(role: 'owner' | 'agent' = 'owner') {
  const response = await post('/login', { email: role + '@example.test', password });
  expect(response.status).toBe(303);
  expect(response.headers.get('Location')).toBe('/pedidos');
  const cookie = response.headers.get('Set-Cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Falta la cookie del panel');
  return cookie;
}

function versionFrom(page: string) {
  const version = /<form class="row" action="\/pedidos\/order-1" method="post"><input type="hidden" name="expectedVersion" value="(\d+)"/.exec(page)?.[1];
  if (!version) throw new Error('Falta la versión en el formulario');
  return version;
}

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  const passwordHash = await hashPassword(password);
  await db.batch(['owner', 'agent'].map((role) => db.prepare(
    'INSERT INTO admins (id, email, password_hash, role) VALUES (?, ?, ?, ?)',
  ).bind(role, role + '@example.test', passwordHash, role)));
});

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM audit_log'),
    db.prepare('DELETE FROM orders'),
    db.prepare(`
      INSERT INTO orders (id, number, tracking_token_hash, buyer_name, buyer_email_enc,
        buyer_phone_enc, ship_address_enc, created_at, updated_at)
      VALUES ('order-1', 1, 'hash-1', 'Cliente de prueba', 'enc', 'enc', 'enc', 1, 1)
    `),
    db.prepare(`
      INSERT INTO order_items (id, order_id, product_name, presentation, qty, unit_amount, line_amount)
      VALUES ('item-1', 'order-1', 'Perfume de prueba', '50 ml', 2, 100, 200)
    `),
    db.prepare(`
      INSERT INTO order_events (id, order_id, seq, actor_type, type, created_at)
      VALUES ('event-1', 'order-1', 1, 'customer', 'created', 1)
    `),
  ]);
});

describe('panel de pedidos', () => {
  it('confirma desde el panel con envío y muestra el total calculado', async () => {
    const cookie = await login('agent');
    await db.prepare('UPDATE orders SET subtotal_amount = 200, expires_at = ?')
      .bind(Date.now() + 60_000).run();
    const before = await (await get(detailPath, cookie)).text();
    expect(before).toContain('action="/pedidos/order-1/envio"');
    expect(before).toContain('name="shippingCost" type="number" min="0" step="1" inputmode="numeric"');
    const response = await post(detailPath + '/envio', {
      carrier: 'Inter Rapidísimo', shippingCost: '12000', shippingEtaDays: '3', expectedVersion: '1',
    }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(detailPath);
    expect(await db.prepare(`SELECT status, payment_status, carrier, shipping_cost, shipping_eta_days,
      subtotal_amount, total_amount, version, expires_at FROM orders`).first()).toEqual({
      status: 'confirmed', payment_status: 'cod_pending', carrier: 'Inter Rapidísimo',
      shipping_cost: 12000, shipping_eta_days: 3, subtotal_amount: 200,
      total_amount: 12200, version: 2, expires_at: null,
    });
    expect(await db.prepare('SELECT admin_id, to_status FROM audit_log').first())
      .toEqual({ admin_id: 'agent', to_status: 'confirmed' });
    const after = await (await get(detailPath, cookie)).text();
    expect(after).toContain('Inter Rapidísimo');
    expect(after).toContain('12.000 COP');
    expect(after).toContain('12.200 COP');
    expect(after).toContain('3 días');
    expect(after).not.toContain('name="shippingCost"');
  });

  it('conserva el envío enviado con versión vieja sin sobrescribir ni auditar', async () => {
    const cookie = await login();
    await db.prepare('UPDATE orders SET version = 2').run();
    const draft = { carrier: 'Otra transportadora', shippingCost: '0', shippingEtaDays: '0', expectedVersion: '1' };
    const conflict = await post(detailPath + '/envio', draft, cookie);
    expect(conflict.status).toBe(409);
    const html = await conflict.text();
    expect(html).toContain('Otro agente lo modificó');
    for (const [key, value] of Object.entries(draft)) {
      expect(html).toMatch(new RegExp('name="' + key + '"[^>]*value="' + value + '"'));
    }
    expect(await db.prepare('SELECT status, version, shipping_cost, total_amount FROM orders').first())
      .toEqual({ status: 'pending_confirmation', version: 2, shipping_cost: null, total_amount: null });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first('n')).toBe(0);

    const accepted = await post(detailPath + '/envio', { ...draft, expectedVersion: '2' }, cookie);
    expect(accepted.status).toBe(303);
    const stale = await post(detailPath + '/envio', draft, cookie);
    expect(stale.status).toBe(409);
    const staleHtml = await stale.text();
    expect(staleHtml).toContain('Transportadora enviada: Otra transportadora');
    expect(staleHtml).not.toContain('name="shippingCost" type="number"');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first('n')).toBe(1);
  });

  it('valida el envío del panel y rechaza peticiones sin sesión o de otro origen', async () => {
    const cookie = await login();
    const valid = { carrier: 'Transportadora', shippingCost: '0', shippingEtaDays: '0', expectedVersion: '1' };
    expect((await post(detailPath + '/envio', valid)).status).toBe(303);
    const foreign = await app.request(origin + detailPath + '/envio', {
      method: 'POST', headers: { Cookie: cookie, Origin: 'https://otro.example' },
      body: new URLSearchParams(valid),
    }, testBindings);
    expect(foreign.status).toBe(403);
    for (const invalid of [
      { carrier: '' }, { carrier: 'x'.repeat(101) }, { shippingCost: '-1' },
      { shippingCost: '1.5' }, { shippingCost: '' }, { shippingEtaDays: '-1' },
      { shippingEtaDays: '1.5' }, { expectedVersion: '0' }, { expectedVersion: '' },
    ]) {
      expect((await post(detailPath + '/envio', { ...valid, ...invalid }, cookie)).status).toBe(400);
    }
    expect(await db.prepare('SELECT version FROM orders').first('version')).toBe(1);
  });

  it('muestra las acciones de pago por rol y rechaza una versión obsoleta', async () => {
    const owner = await login();
    const agent = await login('agent');
    const payment = (paymentStatus: 'paid' | 'refunded', expectedVersion: number, cookie = owner) =>
      app.request(origin + '/admin/orders/1/payment', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
        body: JSON.stringify({ paymentStatus, expectedVersion }),
      }, testBindings);
    const unpaid = await (await get(detailPath, owner)).text();
    expect(unpaid).toContain('<form class="row" action="/pedidos/order-1/pago" method="post">');
    const ownerButton = unpaid.match(/<button[^>]*name="paymentStatus" value="paid"[^>]*>Marcar pagado<\/button>/)?.[0];
    expect(ownerButton).toContain('data-payment-action="paid" data-payment-version="1"');
    expect(ownerButton).not.toMatch(/\sdisabled(?:[\s=>])/);
    expect(await (await get(detailPath, agent)).text())
      .toMatch(/<button[^>]*disabled[^>]*title="Solo el propietario"[^>]*>Marcar pagado/);
    expect((await payment('paid', 1, agent)).status).toBe(403);
    const payForm = (paymentStatus: string, expectedVersion: string, cookie = owner) =>
      post(detailPath + '/pago', { paymentStatus, expectedVersion }, cookie);
    expect((await payForm('paid', '1', agent)).status).toBe(403);

    expect((await post(detailPath, { status: 'confirmed', expectedVersion: '1' }, owner)).status).toBe(303);
    const stale = await payment('paid', 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'order_changed', message: 'Otro agente lo modificó' } });
    const staleForm = await payForm('paid', '1');
    expect(staleForm.status).toBe(409);
    const staleHtml = await staleForm.text();
    expect(staleHtml).toContain('Otro agente lo modificó');
    expect(staleHtml).toContain('Cargar la versión actual para continuar');
    expect(await db.prepare('SELECT payment_status FROM orders').first('payment_status')).toBe('cod_pending');

    expect((await payment('paid', 2)).status).toBe(200);
    expect(await (await get(detailPath, owner)).text())
      .toMatch(/data-payment-action="refunded" data-payment-version="3"[^>]*>Reembolsar/);
    const refund = await payForm('refunded', '3');
    expect(refund.status).toBe(303);
    expect(refund.headers.get('Location')).toBe(detailPath);
    expect(await (await get(detailPath, owner)).text()).not.toContain('data-payment-action=');
  });

  it('renderiza login en español y redirige a quien no tiene sesión', async () => {
    const blocked = await get('/pedidos');
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get('Location')).toBe('/login');
    const page = await get('/login');
    expect(page.headers.get('Content-Type')).toContain('text/html');
    expect(await page.text()).toContain('Iniciar sesión');
  });

  it('pagina 50 pedidos y conserva el filtro en los enlaces', async () => {
    const cookie = await login();
    await db.prepare(`
      WITH RECURSIVE numbers(n) AS (
        SELECT 2 UNION ALL SELECT n + 1 FROM numbers WHERE n < 52
      )
      INSERT INTO orders (id, number, tracking_token_hash, buyer_name, buyer_email_enc,
        buyer_phone_enc, ship_address_enc, created_at, updated_at, status)
      SELECT 'order-' || n, n, 'hash-' || n, 'Cliente ' || n, 'enc', 'enc', 'enc', n, n,
        CASE WHEN n = 52 THEN 'confirmed' ELSE 'pending_confirmation' END FROM numbers
    `).run();
    const first = await (await get('/pedidos?estado=pending_confirmation', cookie)).text();
    expect(first.match(/<a href="\/pedidos\/order-/g)).toHaveLength(50);
    expect(first).toContain('pagina=2&amp;estado=pending_confirmation');
    expect(first).not.toContain('href="/pedidos/order-52"');
    const second = await (await get('/pedidos?estado=pending_confirmation&pagina=2', cookie)).text();
    expect(second.match(/<a href="\/pedidos\/order-/g)).toHaveLength(1);
    expect(second).toContain('href="/pedidos/order-1"');
  });

  it('devuelve 409 en la transición concurrente que pierde y conserva su formulario', async () => {
    const cookie = await login();
    const [firstTab, secondTab] = await Promise.all([
      get(detailPath, cookie).then((response) => response.text()),
      get(detailPath, cookie).then((response) => response.text()),
    ]);
    expect(firstTab).toContain('Perfume de prueba');
    expect(firstTab).toContain('Pedido creado');
    const firstVersion = versionFrom(firstTab);
    const secondVersion = versionFrom(secondTab);
    expect(firstVersion).toBe(secondVersion);

    const [confirm, cancel] = await Promise.all([
      post(detailPath, { status: 'confirmed', expectedVersion: firstVersion }, cookie),
      post(detailPath, { status: 'cancelled', expectedVersion: secondVersion }, cookie),
    ]);
    expect([confirm.status, cancel.status].sort()).toEqual([303, 409]);
    const confirmed = confirm.status === 303;
    const savedStatus = confirmed ? 'confirmed' : 'cancelled';
    const rejectedStatus = confirmed ? 'cancelled' : 'confirmed';
    const conflict = await (confirmed ? cancel : confirm).text();
    expect(conflict).toContain('Otro agente lo modificó');
    expect(conflict).toContain('name="status" value="' + rejectedStatus + '"');
    expect(versionFrom(conflict)).toBe(secondVersion);
    expect(conflict).toContain('Estado actualizado');
    expect(await db.prepare('SELECT status, version FROM orders').first())
      .toEqual({ status: savedStatus, version: 2 });
    const audit = await db.prepare(
      'SELECT admin_id, entity_id, action, from_status, to_status FROM audit_log',
    ).all();
    expect(audit.results).toEqual([{
      admin_id: 'owner', entity_id: 'order-1', action: 'status_changed',
      from_status: 'pending_confirmation', to_status: savedStatus,
    }]);
  });
});
