import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { AppEnv } from '../lib/http';
import { reserveCustomerMessage } from '../lib/orders/message-limit';
import type { OrderStatus } from '../lib/orders/state';
import { activeTelegramConversation, sendTelegramMessage, storeTelegramMessage } from '../lib/telegram';
import type { TelegramMessage } from '../lib/telegram';
import { generateTrackingToken, hashTrackingToken } from '../lib/tokens';

export const roomProtocol = 'portofino.v1';
export const trackingTokenFormat = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const telegramRetryDelays = [1000, 2000, 4000] as const;
const lifetimeMs = 5 * 60 * 1000;
export const customerMessageSchema = z.object({
  id: z.string().uuid(),
  body: z.string().max(2000).trim().min(1),
});
const messageSchema = customerMessageSchema.extend({ type: z.literal('message') });

export type RoomState = {
  status: OrderStatus;
  version: number;
};

type Connection = {
  role: 'customer' | 'agent';
  actorId: string;
  expiresAt: number;
}

type RoomConnection = Connection & {
  orderId: string;
};

type MessageRow = {
  seq: number;
  id: string;
  role: Connection['role'];
  body: string;
  createdAt: number;
};

type TelegramJob = TelegramMessage & {
  orderId: string;
  attempts: number;
  externalId: string | null;
};

export class OrderRoom extends DurableObject<AppEnv['Bindings']> {
  constructor(ctx: DurableObjectState, env: AppEnv['Bindings']) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        hash TEXT PRIMARY KEY, orderId TEXT NOT NULL, role TEXT NOT NULL,
        actorId TEXT NOT NULL, expiresAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, actorId TEXT NOT NULL,
        role TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL,
        UNIQUE (actorId, id)
      );
      CREATE TABLE IF NOT EXISTS telegram_outbox (
        id TEXT PRIMARY KEY, orderId TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, dueAt INTEGER, externalId TEXT
      );
      CREATE INDEX IF NOT EXISTS telegram_outbox_due ON telegram_outbox (dueAt);
      CREATE TABLE IF NOT EXISTS room_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL, version INTEGER NOT NULL
      );
    `);
  }

  async issueTicket(orderId: string, role: Connection['role'], actorId: string, accessEndsAt?: number) {
    const token = generateTrackingToken();
    const hash = await hashTrackingToken(token);
    const now = Date.now();
    const expiresAt = Math.min(now + lifetimeMs, accessEndsAt ?? Infinity);
    this.ctx.storage.sql.exec('DELETE FROM tickets WHERE expiresAt <= ?', now);
    this.ctx.storage.sql.exec('INSERT INTO tickets VALUES (?, ?, ?, ?, ?)',
      hash, orderId, role, actorId, expiresAt);
    return { orderId, token, expiresAt };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Se requiere WebSocket', { status: 426 });
    }
    const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map((p) => p.trim()) ?? [];
    const token = trackingTokenFormat.safeParse(protocols.find((p) => p.startsWith('ticket.'))?.slice(7));
    const after = new URL(request.url).searchParams.get('after') ?? '0';
    if (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(Number(after))) {
      return new Response('Cursor inválido', { status: 400 });
    }
    if (!protocols.includes(roomProtocol) || !token.success) {
      return new Response('Token de conexión inválido', { status: 401 });
    }

    const hash = await hashTrackingToken(token.data);
    const [ticket] = this.ctx.storage.sql.exec<RoomConnection>(
      'DELETE FROM tickets WHERE hash = ? AND expiresAt > ? RETURNING orderId, role, actorId, expiresAt',
      hash, Date.now(),
    ).toArray();
    if (!ticket) return new Response('Token de conexión inválido', { status: 401 });

    const state = await this.env.DB.prepare(
      'SELECT status, version FROM orders WHERE id = ? AND anonymized_at IS NULL',
    ).bind(ticket.orderId).first<RoomState>();
    if (!state) return new Response('Pedido no disponible', { status: 404 });
    if (ticket.expiresAt <= Date.now()) return new Response('Token vencido', { status: 401 });
    this.publishState(state);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(ticket satisfies RoomConnection);
    const latest = this.ctx.storage.sql.exec<RoomState>('SELECT status, version FROM room_state').one();
    this.send(server, { type: 'status', ...latest });
    let cursor = Number(after);
    while (true) {
      const messages = this.ctx.storage.sql.exec<MessageRow>(
        'SELECT seq, id, role, body, createdAt FROM messages WHERE seq > ? ORDER BY seq LIMIT 50',
        cursor,
      ).toArray();
      if (messages.length === 0) break;
      this.send(server, { type: 'history', messages });
      cursor = messages[messages.length - 1]!.seq;
    }
    this.send(server, { type: 'ready' });

    return new Response(null, {
      status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': roomProtocol },
    });
  }

  publishState(state: RoomState) {
    const changed = this.ctx.storage.sql.exec(
      `INSERT INTO room_state VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, version = excluded.version
       WHERE excluded.version > room_state.version RETURNING version`,
      state.status, state.version,
    ).toArray();
    if (changed.length) this.broadcast({ type: 'status', ...state });
  }

  async webSocketMessage(socket: WebSocket, frame: string | ArrayBuffer) {
    const connection = socket.deserializeAttachment() as RoomConnection;
    if (connection.expiresAt <= Date.now()) {
      socket.close(4001, 'Sesión vencida');
      return;
    }
    let payload: unknown;
    if (typeof frame === 'string' && frame.length <= 8192) {
      try { payload = JSON.parse(frame); } catch { /* Invalid frames are rejected below. */ }
    }
    const message = messageSchema.safeParse(payload);
    if (!message.success) {
      this.send(socket, { type: 'error', message: 'Mensaje inválido' });
      return;
    }

    const { id, body } = message.data;
    if (connection.role === 'customer') {
      if (!connection.actorId.startsWith('customer:')) {
        socket.close(4001, 'Vuelve a conectar');
        return;
      }
      const result = await this.postCustomerMessage(connection.actorId.slice('customer:'.length), { id, body });
      if (result.status === 429) this.send(socket, { type: 'rate_limited', id, ...result });
      if (result.status === 200) this.send(socket, { type: 'ack', id });
      return;
    }
    const createdAt = Date.now();
    // Attachments created before Telegram was added have no orderId.
    const conversation = connection.orderId && this.env.TELEGRAM_BOT_TOKEN
      ? await activeTelegramConversation(this.env.DB, { orderId: connection.orderId })
      : null;
    if (connection.expiresAt <= Date.now()) {
      socket.close(4001, 'Sesión vencida');
      return;
    }
    const created = conversation
      ? await this.ctx.blockConcurrencyWhile(async () => {
        await this.scheduleTelegramAlarm(createdAt);
        return this.ctx.storage.transactionSync(() => {
          const row = this.appendMessage({ id, body, createdAt }, connection.actorId, connection.role);
          if (row) {
            this.ctx.storage.sql.exec(
              'INSERT INTO telegram_outbox (id, orderId, body, createdAt, dueAt) VALUES (?, ?, ?, ?, ?)',
              crypto.randomUUID(), conversation.orderId, body, createdAt, createdAt,
            );
          }
          return row;
        });
      })
      : this.appendMessage({ id, body, createdAt }, connection.actorId, connection.role);
    if (created) {
      this.broadcast({ type: 'message', message: created });
      return;
    }
    this.send(socket, { type: 'ack', id });
  }

  postCustomerMessage(tokenHash: string, message: { id: string; body: string }) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const duplicate = this.ctx.storage.sql.exec(
        "SELECT id FROM messages WHERE actorId = 'customer' AND id = ?", message.id,
      ).toArray().length > 0;
      if (duplicate) return { status: 200 as const };

      const reservation = await reserveCustomerMessage(this.env.DB, tokenHash);
      if (!reservation.allowed) return { status: 429 as const, retryAfter: reservation.retryAfter };

      const created = this.appendMessage({ ...message, createdAt: Date.now() }, 'customer', 'customer');
      if (created) this.broadcast({ type: 'message', message: created });
      return { status: 201 as const };
    });
  }

  publishTelegramMessage(message: TelegramMessage) {
    const created = this.appendMessage(message, 'telegram', 'customer');
    if (created) this.broadcast({ type: 'message', message: created });
  }

  private appendMessage(message: TelegramMessage, actorId: string, role: Connection['role']) {
    const [created] = this.ctx.storage.sql.exec<MessageRow>(
      `INSERT INTO messages (id, actorId, role, body, createdAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(actorId, id) DO NOTHING RETURNING seq, id, role, body, createdAt`,
      message.id, actorId, role, message.body, message.createdAt,
    ).toArray();
    return created;
  }

  override async alarm() {
    const storage = this.ctx.storage;
    const [job] = storage.sql.exec<TelegramJob>(
      'SELECT id, orderId, body, createdAt, attempts, externalId FROM telegram_outbox WHERE dueAt <= ? ORDER BY dueAt LIMIT 1',
      Date.now(),
    ).toArray();
    if (job) {
      const leaseUntil = Date.now() + 60_000;
      await storage.setAlarm(leaseUntil);
      storage.sql.exec('UPDATE telegram_outbox SET dueAt = ? WHERE id = ?', leaseUntil, job.id);
      await this.deliverTelegramJob(job);
    }
    const { dueAt } = storage.sql.exec<{ dueAt: number | null }>(
      'SELECT MIN(dueAt) AS dueAt FROM telegram_outbox',
    ).one();
    if (dueAt !== null) await storage.setAlarm(dueAt);
  }

  private async deliverTelegramJob(job: TelegramJob) {
    const { DB, TELEGRAM_BOT_TOKEN } = this.env;
    const sql = this.ctx.storage.sql;
    const conversation = await activeTelegramConversation(DB, { orderId: job.orderId });
    if (!conversation) {
      sql.exec('DELETE FROM telegram_outbox WHERE id = ?', job.id);
      return;
    }

    let externalId = job.externalId;
    if (!externalId) {
      if (job.attempts > telegramRetryDelays.length) {
        sql.exec('UPDATE telegram_outbox SET dueAt = NULL WHERE id = ?', job.id);
        return;
      }
      const retryDelay = telegramRetryDelays[job.attempts];
      sql.exec('UPDATE telegram_outbox SET attempts = attempts + 1 WHERE id = ?', job.id);
      try {
        if (!TELEGRAM_BOT_TOKEN) throw new Error('Telegram sin configurar');
        externalId = await sendTelegramMessage(TELEGRAM_BOT_TOKEN, conversation, job.body);
      } catch {
        const dueAt = retryDelay === undefined ? null : Date.now() + retryDelay;
        sql.exec('UPDATE telegram_outbox SET dueAt = ? WHERE id = ?', dueAt, job.id);
        return;
      }
      // Persist the Telegram ID before writing to D1 so a D1 failure cannot resend the reply.
      sql.exec('UPDATE telegram_outbox SET externalId = ? WHERE id = ?', externalId, job.id);
    }
    await storeTelegramMessage(DB, conversation, externalId, 'out', job);
    sql.exec('DELETE FROM telegram_outbox WHERE id = ?', job.id);
  }

  private async scheduleTelegramAlarm(dueAt: number) {
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > dueAt) await this.ctx.storage.setAlarm(dueAt);
  }

  webSocketClose(socket: WebSocket) {
    socket.close();
  }

  private broadcast(frame: unknown) {
    for (const socket of this.ctx.getWebSockets()) {
      const connection = socket.deserializeAttachment() as Connection;
      if (connection.expiresAt <= Date.now()) {
        socket.close(4001, 'Sesión vencida');
      } else {
        this.send(socket, frame);
      }
    }
  }

  private send(socket: WebSocket, frame: unknown) {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // A closed connection recovers persisted messages on reconnect.
    }
  }
}
