/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, createScheduledController } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import app from '../index';
import type { AppEnv } from '../lib/http';
import { hashPassword } from '../lib/passwords';

const bindings = env as AppEnv['Bindings'] & { TEST_MIGRATIONS: D1Migration[] };
const { DB } = bindings;

it('anonimiza un pedido vencido una sola vez y conserva su número e ítems en el panel', async () => {
  const controller = createScheduledController({ cron: '0 * * * *' });
  const cutoff = controller.scheduledTime;
  const migrations = bindings.TEST_MIGRATIONS;
  const migrationIndex = migrations.findIndex(({ name }) => name === '0004_order_retention.sql');
  expect(migrationIndex).toBeGreaterThan(0);
  await applyD1Migrations(DB, migrations.slice(0, migrationIndex));
  const createOrder = DB.prepare(`
    INSERT INTO orders (id, number, tracking_token_hash, status, buyer_name, buyer_email_enc,
      buyer_phone_enc, ship_address_enc, ship_notes, ship_city, subtotal_amount, shipping_cost,
      total_amount, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, 'confirmed', 'Nombre privado', 'correo', 'teléfono', 'dirección',
      'nota privada', 'Medellín', 25000, 5000, 30000, 1, 1, ?)
  `);
  const password = 'contraseña de prueba';
  await DB.batch([
    createOrder.bind('due', 712, 'hash-due', cutoff),
    createOrder.bind('future', 713, 'hash-future', cutoff + 1),
    createOrder.bind('no-expiry', 714, 'hash-no-expiry', null),
    createOrder.bind('delivered', 715, 'hash-delivered', cutoff - 1),
    DB.prepare("UPDATE orders SET status = 'delivered' WHERE id = 'delivered'"),
    DB.prepare(`
      INSERT INTO order_items (id, order_id, product_name, presentation, qty, unit_amount, line_amount)
      VALUES ('item', 'due', 'Perfume de prueba', '50 ml', 1, 25000, 25000)
    `),
    DB.prepare(`
      INSERT INTO order_events (id, order_id, seq, actor_type, type, created_at)
      VALUES ('event', 'due', 1, 'customer', 'created', 1)
    `),
    DB.prepare(`
      INSERT INTO conversations (id, order_id, telegram_chat_id)
      VALUES ('conversation', 'due', '123')
    `),
    DB.prepare(`
      INSERT INTO messages (id, conversation_id, channel, direction, body, created_at)
      VALUES ('message', 'conversation', 'telegram', 'in', 'Consulta de prueba', 1)
    `),
    DB.prepare('INSERT INTO admins (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .bind('agent', 'agent@example.test', await hashPassword(password), 'agent'),
  ]);
  await applyD1Migrations(DB, migrations.slice(migrationIndex));
  expect(await DB.prepare("SELECT buyer_name FROM orders WHERE id = 'due'").first('buyer_name'))
    .toBe('Nombre privado');
  expect((await DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  expect(await DB.prepare(`
    SELECT c.order_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = 'message'
  `).first('order_id')).toBe('due');

  await Promise.all([app.scheduled(controller, bindings), app.scheduled(controller, bindings)]);
  expect(await DB.prepare("SELECT * FROM orders WHERE id = 'due'").first()).toMatchObject({
    number: 712, status: 'expired', version: 2, anonymized_at: cutoff,
    buyer_name: null, buyer_email_enc: null, buyer_phone_enc: null, ship_address_enc: null, ship_notes: null,
    ship_city: 'Medellín', subtotal_amount: 25000, shipping_cost: 5000, total_amount: 30000,
  });
  const untouched = await DB.prepare(`
    SELECT status, buyer_name, anonymized_at FROM orders WHERE id NOT IN ('due', 'delivered') ORDER BY number
  `).all();
  expect(untouched.results).toEqual(Array.from({ length: 2 }, () => ({
    status: 'confirmed', buyer_name: 'Nombre privado', anonymized_at: null,
  })));
  expect(await DB.prepare("SELECT status, anonymized_at, version FROM orders WHERE id = 'delivered'").first())
    .toEqual({ status: 'delivered', anonymized_at: null, version: 1 });
  expect(await DB.prepare("SELECT COUNT(*) AS total FROM order_events WHERE order_id = 'delivered'").first('total'))
    .toBe(0);
  const history = await DB.prepare(`
    SELECT seq, actor_type, type, from_status, to_status, payload FROM order_events
    WHERE order_id = 'due' ORDER BY seq
  `).all();
  expect(history.results).toEqual([
    { seq: 1, actor_type: 'customer', type: 'created', from_status: null, to_status: null, payload: null },
    { seq: 2, actor_type: 'system', type: 'anonymized', from_status: 'confirmed', to_status: 'expired', payload: null },
  ]);

  const panelEnv = { ...bindings, ADMIN_SESSION_SECRET: 'secreto independiente de prueba de retención' };
  const login = await app.request('https://portofino.example.test/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'agent@example.test', password }),
  }, panelEnv);
  const cookie = login.headers.get('Set-Cookie')?.split(';')[0];
  if (!cookie) throw new Error('Falta la sesión del panel');
  for (const path of ['/pedidos?estado=expired', '/pedidos/due']) {
    const page = await app.request('https://portofino.example.test' + path, {
      headers: { Cookie: cookie },
    }, panelEnv);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('#712');
    expect(html).toContain('Datos anonimizados');
    expect(html).not.toContain('Nombre privado');
    if (path === '/pedidos/due') {
      expect(html).toContain('Perfume de prueba');
      expect(html).toContain('Medellín');
    }
  }
});
