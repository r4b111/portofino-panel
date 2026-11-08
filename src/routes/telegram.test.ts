/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, expect, it, vi } from 'vitest';
import app from '../index';
import type { AppEnv } from '../lib/http';
import { generateTrackingToken, hashTrackingToken } from '../lib/tokens';

const testEnv = env as AppEnv['Bindings'] & { TEST_MIGRATIONS: D1Migration[] };
const { DB, ORDER_ROOMS } = testEnv;
const webhookSecret = 'secret-for-tests';
const token = generateTrackingToken();
const room = ORDER_ROOMS.getByName('telegram-order');

function update(text: string, messageId: number, secret = webhookSecret, updateId = messageId) {
  return app.request('/webhooks/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: messageId, message_thread_id: 5, text,
        chat: { id: 45, type: 'private' },
      },
    }),
  }, { ...testEnv, TELEGRAM_WEBHOOK_SECRET: webhookSecret });
}

beforeAll(async () => {
  await applyD1Migrations(DB, testEnv.TEST_MIGRATIONS);
  await DB.prepare(`
    INSERT INTO orders (id, number, tracking_token_hash, buyer_name, buyer_email_enc,
      buyer_phone_enc, ship_address_enc, created_at, updated_at)
    VALUES ('telegram-order', 1, ?, 'Cliente de prueba', 'enc', 'enc', 'enc', 1, 1)
  `).bind(await hashTrackingToken(token)).run();
});

it('autentica el webhook, vincula el chat y deduplica en D1 y en la sala', async () => {
  expect((await update('/start ' + token, 1, 'wrong')).status).toBe(401);
  expect(await DB.prepare('SELECT COUNT(*) AS count FROM conversations').first('count')).toBe(0);
  expect((await update('/start ' + token, 1)).status).toBe(200);
  expect((await update('/start ' + token, 1)).status).toBe(200);
  expect(await DB.prepare('SELECT telegram_chat_id, telegram_thread_id FROM conversations').all())
    .toMatchObject({ results: [{ telegram_chat_id: '45', telegram_thread_id: 5 }] });
  expect(await DB.prepare('SELECT COUNT(*) AS count FROM messages').first('count')).toBe(0);

  const responses = await Promise.all([update('Consulta', 2), update('Consulta', 2)]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect((await update('Otro update para el mismo mensaje', 2, webhookSecret, 3)).status).toBe(200);
  expect(await DB.prepare('SELECT body, external_id, direction FROM messages').all())
    .toMatchObject({ results: [{ body: 'Consulta', external_id: '2', direction: 'in' }] });
  const replay = await runInDurableObject(room, (_instance, state) =>
    state.storage.sql.exec('SELECT body, role FROM messages ORDER BY seq').toArray());
  expect(replay).toEqual([{ body: 'Consulta', role: 'customer' }]);
});

it('intenta el envío cuatro veces con backoff y registra una entrega exitosa', async () => {
  expect((await update('/start ' + token, 1)).status).toBe(200);
  const result = await runInDurableObject(room, async (instance, state) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 10 } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO telegram_outbox (id, orderId, body, createdAt, dueAt) VALUES ('job', 'telegram-order', 'Respuesta', 1, 1)");
      const delays: number[] = [];
      for (const seconds of [1, 2, 4]) {
        const start = Date.now();
        await instance.alarm();
        const { dueAt } = sql.exec<{ dueAt: number }>("SELECT dueAt FROM telegram_outbox WHERE id = 'job'").one();
        delays.push(Math.abs(dueAt - (start + seconds * 1000)));
        sql.exec("UPDATE telegram_outbox SET dueAt = 1 WHERE id = 'job'");
      }
      await instance.alarm();
      const calls = fetchMock.mock.calls;
      const payload: unknown = JSON.parse(String(calls[0]?.[1]?.body));
      return { delays, calls: calls.length, payload };
    } finally {
      await state.storage.deleteAlarm();
      vi.unstubAllGlobals();
    }
  });
  expect(result.calls).toBe(4);
  expect(result.delays.every((delta) => delta < 500)).toBe(true);
  expect(result.payload).toEqual({ chat_id: '45', message_thread_id: 5, text: 'Respuesta' });
  expect(await DB.prepare("SELECT external_id, body FROM messages WHERE direction = 'out'").all())
    .toMatchObject({ results: [{ external_id: '10', body: 'Respuesta' }] });
});
