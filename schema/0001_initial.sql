-- Pholia accounts database
-- A "Pholia account" is a passkey-protected wrapper around one or more saved
-- ABS server credentials, so a user can biometrically log in on a new device
-- and have their server list (with passwords for silent JWT renewal) restored.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bearer-token sessions issued after passkey authentication.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One passkey credential per device per user (a user can register multiple
-- devices). Public key is COSE-encoded base64url, verified server-side via
-- Web Crypto.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

-- Short-lived challenges for WebAuthn ceremonies. user_id is NULL during
-- discoverable-credential authentication (server doesn't know who's logging
-- in until the assertion comes back).
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL UNIQUE,
  user_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('register', 'authenticate')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenge ON webauthn_challenges(challenge);

-- Saved ABS server credentials. encrypted_password is AES-GCM-encrypted with
-- a Worker-side key (Pages secret ENCRYPTION_KEY) so D1 leaks don't expose
-- plaintext passwords. server_url is normalized (no trailing slash).
CREATE TABLE IF NOT EXISTS abs_servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_url TEXT NOT NULL,
  username TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  UNIQUE(user_id, server_url, username)
);
CREATE INDEX IF NOT EXISTS idx_abs_servers_user ON abs_servers(user_id);
