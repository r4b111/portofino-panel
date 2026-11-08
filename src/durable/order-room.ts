import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { AppEnv } from '../lib/http';
import type { OrderStatus } from '../lib/orders/state';
import { generateTrackingToken, hashTrackingToken } from '../lib/tokens';

export const roomProtocol = 'portofino.v1';
export const trackingTokenFormat = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const lifetimeMs = 5 * 60 * 1000;
const messageSchema = z.object({
  type: z.literal('message'),
  id: z.string().uuid(),
  body: z.string().trim().min(1).max(2000),
});

export type RoomState = {
  status: OrderStatus;
  version: number;
};

type Connection = {
  role: 'customer' | 'agent';
  actorId: string;
  expiresAt: number;
}

type Ticket = Connection & {
  orderId: string;
};

type MessageRow = {
  seq: number;
  id: string;
  role: Connection['role'];
  body: string;
  createdAt: number;
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
    const [ticket] = this.ctx.storage.sql.exec<Ticket>(
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
    server.serializeAttachment({
      role: ticket.role, actorId: ticket.actorId, expiresAt: ticket.expiresAt,
    } satisfies Connection);
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

  webSocketMessage(socket: WebSocket, frame: string | ArrayBuffer) {
    const connection = socket.deserializeAttachment() as Connection;
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
    const [created] = this.ctx.storage.sql.exec<MessageRow>(
      `INSERT INTO messages (id, actorId, role, body, createdAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(actorId, id) DO NOTHING RETURNING seq, id, role, body, createdAt`,
      id, connection.actorId, connection.role, body, Date.now(),
    ).toArray();
    if (created) {
      this.broadcast({ type: 'message', message: created });
      return;
    }

    this.send(socket, { type: 'ack', id });
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
