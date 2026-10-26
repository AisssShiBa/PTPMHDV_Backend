CREATE TABLE recipient_lookup_limits (
  auth_user_id TEXT PRIMARY KEY,
  attempts TIMESTAMPTZ(3)[] NOT NULL DEFAULT ARRAY[]::TIMESTAMPTZ(3)[]
);

CREATE INDEX users_phone_idx ON users(phone);
CREATE INDEX users_email_lower_idx ON users(LOWER(email));
