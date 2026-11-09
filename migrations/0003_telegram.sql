CREATE TABLE conversations (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders (id) ON DELETE CASCADE,
  telegram_chat_id TEXT NOT NULL,
  telegram_thread_id INTEGER
);
CREATE UNIQUE INDEX conversations_telegram_uq
  ON conversations (telegram_chat_id, COALESCE(telegram_thread_id, 0));

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  telegram_chat_id TEXT,
  external_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_telegram_external_uq ON messages (telegram_chat_id, external_id);
CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at);
