ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash CHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_expires_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_users_password_reset_token_hash
  ON users(password_reset_token_hash) WHERE password_reset_token_hash IS NOT NULL;