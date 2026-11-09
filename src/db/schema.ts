import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { actorTypes, orderEventTypes, orderStatuses, paymentStatuses } from '../lib/orders/state';

export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  number: integer('number').notNull(),
  trackingTokenHash: text('tracking_token_hash').notNull(),
  tokenExpiresAt: integer('token_expires_at'),
  status: text('status', { enum: orderStatuses }).notNull().default('pending_confirmation'),
  paymentStatus: text('payment_status', { enum: paymentStatuses }).notNull().default('unpaid'),
  currency: text('currency').notNull().default('COP'),
  subtotalAmount: integer('subtotal_amount').notNull().default(0),
  shippingCost: integer('shipping_cost'),
  shippingEtaDays: integer('shipping_eta_days'),
  carrier: text('carrier'),
  totalAmount: integer('total_amount'),
  customerId: text('customer_id'),
  buyerName: text('buyer_name'),
  buyerEmailEnc: text('buyer_email_enc'),
  buyerPhoneEnc: text('buyer_phone_enc'),
  shipAddressEnc: text('ship_address_enc'),
  shipCity: text('ship_city'),
  shipNotes: text('ship_notes'),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  expiresAt: integer('expires_at'),
  anonymizedAt: integer('anonymized_at'),
}, (table) => [
  uniqueIndex('orders_token_hash_uq').on(table.trackingTokenHash),
  uniqueIndex('orders_number_uq').on(table.number),
  index('orders_status_created_idx').on(table.status, table.createdAt),
  index('orders_expires_idx').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
  check('orders_status_check', sql`${table.status} IN ${orderStatuses}`.inlineParams()),
  check('orders_payment_status_check', sql`${table.paymentStatus} IN ${paymentStatuses}`.inlineParams()),
  check('orders_subtotal_check', sql`${table.subtotalAmount} >= 0`),
  check('orders_shipping_cost_check', sql`${table.shippingCost} >= 0`),
  check('orders_total_check', sql`${table.totalAmount} >= 0`),
]);

export const orderItems = sqliteTable('order_items', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  productId: text('product_id'),
  productName: text('product_name').notNull(),
  presentation: text('presentation').notNull(),
  qty: integer('qty').notNull(),
  unitAmount: integer('unit_amount').notNull(),
  lineAmount: integer('line_amount').notNull(),
}, (table) => [
  index('order_items_order_idx').on(table.orderId),
  check('order_items_qty_check', sql`${table.qty} > 0`),
  check('order_items_unit_check', sql`${table.unitAmount} >= 0`),
  check('order_items_line_check', sql`${table.lineAmount} >= 0`),
]);

export const orderEvents = sqliteTable('order_events', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  actorType: text('actor_type', { enum: actorTypes }).notNull(),
  actorId: text('actor_id'),
  type: text('type', { enum: orderEventTypes }).notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  payload: text('payload'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('order_events_order_idx').on(table.orderId, table.createdAt),
  uniqueIndex('order_events_seq_uq').on(table.orderId, table.seq),
  check('order_events_actor_check', sql`${table.actorType} IN ${actorTypes}`.inlineParams()),
  check('order_events_type_check', sql`${table.type} IN ${orderEventTypes}`.inlineParams()),
]);

export const admins = sqliteTable('admins', {
  id: text('id').primaryKey().notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['owner', 'agent'] }).notNull(),
  totpSecret: text('totp_secret'),
}, (table) => [
  check('admins_role_check', sql`${table.role} IN ('owner', 'agent')`),
]);

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey().notNull(),
  adminId: text('admin_id').references(() => admins.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('audit_log_entity_created_idx').on(table.entity, table.entityId, table.createdAt),
]);

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey().notNull(),
  orderId: text('order_id').notNull().unique().references(() => orders.id, { onDelete: 'cascade' }),
  telegramChatId: text('telegram_chat_id').notNull(),
  telegramThreadId: integer('telegram_thread_id'),
}, (table) => [
  uniqueIndex('conversations_telegram_uq').on(table.telegramChatId, sql`COALESCE(${table.telegramThreadId}, 0)`),
]);

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey().notNull(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  channel: text('channel', { enum: ['web', 'telegram'] }).notNull(),
  direction: text('direction', { enum: ['in', 'out'] }).notNull(),
  telegramChatId: text('telegram_chat_id'),
  externalId: text('external_id'),
  body: text('body').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  uniqueIndex('messages_telegram_external_uq').on(table.telegramChatId, table.externalId),
  index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
  check('messages_channel_check', sql`${table.channel} IN ('web', 'telegram')`),
  check('messages_direction_check', sql`${table.direction} IN ('in', 'out')`),
]);

export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey().notNull(),
  windowStart: integer('window_start').notNull(),
  count: integer('count').notNull(),
}, (table) => [
  check('rate_limits_count_check', sql`${table.count} BETWEEN 1 AND 10`),
]);
