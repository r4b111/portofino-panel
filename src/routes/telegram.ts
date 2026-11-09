import { Hono } from 'hono';
import { z } from 'zod';
import { trackingTokenFormat } from '../durable/order-room';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/http';
import { findRealtimeOrder } from '../lib/orders/service';
import { activeTelegramConversation, storeTelegramMessage, verifyWebhookSecret } from '../lib/telegram';
import type { TelegramMessage } from '../lib/telegram';

const updateSchema = z.object({
  update_id: z.number().int().safe(),
  message: z.object({
    message_id: z.number().int().safe().nonnegative(),
    message_thread_id: z.number().int().safe().positive().optional(),
    chat: z.object({ id: z.number().int().safe(), type: z.string() }),
    text: z.string().max(4096).optional(),
  }).optional(),
});

export const telegramRoutes = new Hono<AppEnv>();

telegramRoutes.post('/webhooks/telegram', async (context) => {
  const { DB, ORDER_ROOMS, TELEGRAM_WEBHOOK_SECRET } = context.env;
  if (!TELEGRAM_WEBHOOK_SECRET) {
    throw new HttpError(503, 'telegram_unavailable', 'Telegram sin configurar');
  }
  const receivedSecret = context.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!await verifyWebhookSecret(TELEGRAM_WEBHOOK_SECRET, receivedSecret)) {
    throw new HttpError(401, 'invalid_webhook_secret', 'Webhook no autorizado');
  }

  const update = updateSchema.safeParse(await context.req.json().catch(() => null));
  if (!update.success) throw new HttpError(400, 'invalid_update', 'Actualización inválida');
  const message = update.data.message;
  const body = message?.text?.trim();
  if (!message || !body || message.chat.type !== 'private' || !message.message_id) {
    return context.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const threadId = message.message_thread_id ?? null;
  if (/^\/start(?:@[^\s]+)?(?:\s|$)/i.test(body)) {
    const token = trackingTokenFormat.safeParse(body.split(/\s+/)[1]);
    if (token.success) {
      const result = await findRealtimeOrder(DB, token.data);
      if (result.kind === 'active') {
        const now = Date.now();
        await DB.prepare(`
          INSERT INTO conversations (id, order_id, telegram_chat_id, telegram_thread_id)
          SELECT ?, id, ?, ? FROM orders WHERE id = ? AND anonymized_at IS NULL AND status <> 'expired'
            AND (expires_at IS NULL OR expires_at > ?) AND (token_expires_at IS NULL OR token_expires_at > ?)
          ON CONFLICT DO NOTHING
        `).bind(crypto.randomUUID(), chatId, threadId, result.order.id, now, now).run();
      }
    }
    return context.json({ ok: true });
  }

  const conversation = await activeTelegramConversation(DB, { chatId, threadId });
  if (conversation) {
    const externalId = String(message.message_id);
    await storeTelegramMessage(DB, conversation, externalId, 'in', {
      id: crypto.randomUUID(), body, createdAt: Date.now(),
    });
    // A retry also repairs a failure between D1 insertion and room delivery.
    const saved = await DB.prepare(`
      SELECT id, body, created_at AS createdAt FROM messages
      WHERE telegram_chat_id = ? AND external_id = ? AND conversation_id = ? AND direction = 'in'
    `).bind(chatId, externalId, conversation.id).first<TelegramMessage>();
    if (saved) await ORDER_ROOMS.getByName(conversation.orderId).publishTelegramMessage(saved);
  }
  return context.json({ ok: true });
});
