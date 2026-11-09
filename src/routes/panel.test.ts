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

async function login() {
  const response = await post('/login', { email: 'owner@example.test', password });
  expect(response.status).toBe(303);
  expect(response.headers.get('Location')).toBe('/pedidos');
  const cookie = response.headers.get('Set-Cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Falta la cookie del panel');
  return cookie;
}

function versionFrom(page: string) {
  const version = /name="expectedVersion" value="(\d+)"/.exec(page)?.[1];
  if (!version) throw new Error('Falta la versión en el formulario');
  return version;
}

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  await db.prepare(
    'INSERT INTO admins (id, email, password_hash, role) VALUES (?, ?, ?, ?)',
  ).bind('owner', 'owner@example.test', await hashPassword(password), 'owner').run();
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

  it('conserva el formulario de la segunda pestaña y devuelve 409', async () => {
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

    const first = await post(detailPath, { status: 'confirmed', expectedVersion: firstVersion }, cookie);
    expect(first.status).toBe(303);
    const second = await post(detailPath, { status: 'cancelled', expectedVersion: secondVersion }, cookie);
    expect(second.status).toBe(409);
    const conflict = await second.text();
    expect(conflict).toContain('Otro agente lo modificó');
    expect(conflict).toContain('name="status" value="cancelled"');
    expect(versionFrom(conflict)).toBe(secondVersion);
    expect(conflict).toContain('Cancelar pedido');
    expect(conflict).toContain('Estado actualizado');
    expect(await db.prepare('SELECT status, version FROM orders').first())
      .toEqual({ status: 'confirmed', version: 2 });
    expect(await db.prepare('SELECT COUNT(*) AS total FROM audit_log').first('total')).toBe(1);
  });
});
