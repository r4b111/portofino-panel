import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type TelegramConversation = {
  id: string;
  orderId: string;
  chatId: string;
  threadId: number | null;
};

export type TelegramMessage = {
  id: string;
  body: string;
  createdAt: number;
};

export async function verifyWebhookSecret(secret: string, received: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [expectedHash, receivedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
  ]);
  return timingSafeEqual(new Uint8Array(expectedHash), new Uint8Array(receivedHash));
}

export function activeTelegramConversation(
  db: D1Database,
  scope: { orderId: string } | { chatId: string; threadId: number | null },
) {
  const filter = 'orderId' in scope
    ? 'c.order_id = ?'
    : 'c.telegram_chat_id = ? AND COALESCE(c.telegram_thread_id, 0) = ?';
  const bindings = 'orderId' in scope ? [scope.orderId] : [scope.chatId, scope.threadId ?? 0];
  const now = Date.now();
  return db.prepare(`
    SELECT c.id, c.order_id AS orderId, c.telegram_chat_id AS chatId, c.telegram_thread_id AS threadId
    FROM conversations c JOIN orders o ON o.id = c.order_id
    WHERE ${filter} AND o.anonymized_at IS NULL AND o.status <> 'expired'
      AND (o.expires_at IS NULL OR o.expires_at > ?)
  `).bind(...bindings, now).first<TelegramConversation>();
}

export async function storeTelegramMessage(
  db: D1Database,
  conversation: TelegramConversation,
  externalId: string,
  direction: 'in' | 'out',
  message: TelegramMessage,
) {
  await db.prepare(`
    INSERT INTO messages (id, conversation_id, channel, direction, telegram_chat_id, external_id, body, created_at)
    VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_chat_id, external_id) DO NOTHING
  `).bind(message.id, conversation.id, direction, conversation.chatId, externalId, message.body, message.createdAt).run();
}

const sentMessage = z.object({
  ok: z.literal(true),
  result: z.object({ message_id: z.number().int().positive() }),
});

export async function sendTelegramMessage(
  token: string,
  conversation: TelegramConversation,
  text: string,
): Promise<string> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: conversation.chatId,
      message_thread_id: conversation.threadId ?? undefined,
      text,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Telegram rechazó el envío');
  return String(sentMessage.parse(await response.json()).result.message_id);
}
