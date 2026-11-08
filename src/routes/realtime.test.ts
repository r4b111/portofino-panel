/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../index';
import type { AppEnv } from '../lib/http';
import { hashPassword } from '../lib/passwords';
import { generateTrackingToken, hashTrackingToken } from '../lib/tokens';

const testEnv = env as AppEnv['Bindings'] & { TEST_MIGRATIONS: D1Migration[] };
const bindings = { ...testEnv, ADMIN_SESSION_SECRET: 'firma independiente de prueba para tiempo real' };
const origin = 'https://portofino.example.test';
const password = 'contraseña de prueba';
const tracking = generateTrackingToken();

function request(path: string, init?: RequestInit) {
  return app.request(origin + path, init, bindings);
}

type Ticket = { orderId: string; token: string; expiresAt: number };
type Message = { seq: number; id: string; role: string; body: string };
type Frame =
  | { type: 'history'; messages: Message[] }
  | { type: 'message'; message: Message }
  | { type: 'status'; status: string; version: number }
  | { type: 'ack'; id: string }
  | { type: 'ready' };

async function customerTicket() {
  const response = await request('/api/orders/realtime-token', {
    method: 'POST', headers: { 'X-Tracking-Token': tracking },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return response.json<Ticket>();
}

function upgrade(ticket: Ticket, after = 0, id = ticket.orderId) {
  return request('/api/orders/' + id + '/realtime?after=' + after, {
    headers: { Upgrade: 'websocket', Origin: origin,
      'Sec-WebSocket-Protocol': 'portofino.v1, ticket.' + ticket.token },
  });
}

const sockets: WebSocket[] = [];

async function connect(ticket: Ticket, after = 0) {
  const response = await upgrade(ticket, after);
  expect(response.status).toBe(101);
  expect(response.headers.get('Sec-WebSocket-Protocol')).toBe('portofino.v1');
  const socket = response.webSocket;
  if (!socket) throw new Error('Falta el WebSocket');
  sockets.push(socket);
  const frames: Frame[] = [];
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
  });
  socket.accept();
  await expect.poll(() => frames.some((frame) => frame.type === 'ready')).toBe(true);
  return { socket, frames };
}

function messages(frames: Frame[]) {
  return frames.flatMap((frame) =>
    frame.type === 'history' ? frame.messages : frame.type === 'message' ? [frame.message] : []);
}

beforeAll(async () => {
  const db = bindings.DB;
  await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
  await db.batch([
    db.prepare(`
      INSERT INTO orders (id, number, tracking_token_hash, buyer_name, buyer_email_enc,
        buyer_phone_enc, ship_address_enc, created_at, updated_at)
      VALUES ('room-1', 1, ?, 'Cliente de prueba', 'enc', 'enc', 'enc', 1, 1)
    `).bind(await hashTrackingToken(tracking)),
    db.prepare('INSERT INTO admins (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .bind('agent', 'agent@example.test', await hashPassword(password), 'agent'),
  ]);
});

describe('tiempo real del pedido', () => {
  it('difunde entre cliente y panel, recupera historial y deduplica reenvíos', async () => {
    try {
      expect(await (await request('/seguimiento')).text()).toContain('data-order-chat');
      const startedAt = Date.now();
      const ticket = await customerTicket();
      expect(ticket.expiresAt).toBeGreaterThanOrEqual(startedAt + 300_000);
      expect(ticket.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
      expect((await upgrade(ticket, 0, 'otro-pedido')).status).toBe(401);
      const customer = await connect(ticket);
      expect((await upgrade(ticket)).status).toBe(401);

      const login = await request('/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'agent@example.test', password }),
      });
      const cookie = login.headers.get('Set-Cookie')?.split(';', 1)[0];
      if (!cookie) throw new Error('Falta sesión administrativa');
      const panelPage = await request('/pedidos/room-1', { headers: { Cookie: cookie } });
      expect(await panelPage.text()).toContain('data-ticket-url="/api/pedidos/room-1/realtime-token"');
      const panelTicket = await request('/api/pedidos/room-1/realtime-token', {
        method: 'POST', headers: { Cookie: cookie },
      });
      const panel = await connect(await panelTicket.json<Ticket>());

      const sent = { type: 'message', id: crypto.randomUUID(), body: 'Hola desde el pedido' };
      customer.socket.send(JSON.stringify(sent));
      await expect.poll(() => messages(panel.frames)).toMatchObject([{ id: sent.id, role: 'customer' }]);

      customer.socket.close(1000);
      const reply = { type: 'message', id: crypto.randomUUID(), body: 'Respuesta del equipo' };
      panel.socket.send(JSON.stringify(reply));
      await expect.poll(() => messages(panel.frames)).toHaveLength(2);

      const reopened = await connect(await customerTicket());
      const recovered = messages(reopened.frames);
      expect(recovered.map((message) => message.id)).toEqual([sent.id, reply.id]);
      const cursor = recovered[1]!.seq;
      reopened.socket.send(JSON.stringify(sent));
      await expect.poll(() => reopened.frames).toContainEqual({ type: 'ack', id: sent.id });
      expect(messages(reopened.frames)).toHaveLength(2);
      expect(messages(panel.frames)).toHaveLength(2);

      const resumed = await connect(await customerTicket(), cursor);
      expect(messages(resumed.frames)).toEqual([]);
      expect(messages((await connect(await customerTicket())).frames).map((message) => message.id))
        .toEqual([sent.id, reply.id]);

      const changed = await request('/admin/orders/1/status', {
        method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed' }),
      });
      expect(changed.status).toBe(200);
      for (const connection of [panel, reopened, resumed]) {
        await expect.poll(() => connection.frames).toContainEqual({
          type: 'status', status: 'confirmed', version: 2,
        });
      }
    } finally {
      for (const socket of sockets.splice(0)) socket.close(1000);
    }
  });

  it('rechaza el token efímero vencido y el acceso público sin credencial', async () => {
    expect((await request('/api/orders/realtime-token', { method: 'POST' })).status).toBe(401);
    const ticket = await customerTicket();
    const hash = await hashTrackingToken(ticket.token);
    await runInDurableObject(bindings.ORDER_ROOMS.getByName(ticket.orderId), (_room, state) => {
      state.storage.sql.exec('UPDATE tickets SET expiresAt = 0 WHERE hash = ?', hash);
    });
    expect((await upgrade(ticket)).status).toBe(401);
  });
});
