CREATE TABLE admins (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
  totp_secret TEXT
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  admin_id TEXT REFERENCES admins (id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_entity_created_idx ON audit_log (entity, entity_id, created_at);
