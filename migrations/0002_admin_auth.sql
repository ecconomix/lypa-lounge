-- Authentication uses UTC Unix seconds. Raw session tokens are never persisted.
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX admin_sessions_expiry ON admin_sessions (expires_at);

CREATE TABLE admin_login_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX admin_login_limits_expiry ON admin_login_limits (expires_at);
