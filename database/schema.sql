-- Fresh WORLD TG SHOP schema. Run against a NEW empty PostgreSQL database.
BEGIN;

CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','seller','support','owner')),
  balance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(18,2) NOT NULL CHECK (price > 0),
  price_from BOOLEAN NOT NULL DEFAULT FALSE,
  max_price NUMERIC(18,2),
  category VARCHAR(80) NOT NULL,
  subcategory VARCHAR(100) NOT NULL DEFAULT '',
  seller_id BIGINT NOT NULL REFERENCES users(telegram_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (max_price IS NULL OR max_price >= price)
);
CREATE INDEX IF NOT EXISTS products_status_created_idx ON products(status, created_at DESC);
CREATE INDEX IF NOT EXISTS products_seller_idx ON products(seller_id);

CREATE TABLE IF NOT EXISTS activation_keys (
  key_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('seller','support')),
  used_by BIGINT REFERENCES users(telegram_id),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('cryptobot','sbp','card','ton_usdt')),
  provider_payment_id TEXT,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired','manual_review')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  UNIQUE(provider, provider_payment_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  buyer_id BIGINT NOT NULL REFERENCES users(telegram_id),
  seller_id BIGINT NOT NULL REFERENCES users(telegram_id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  commission NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (commission >= 0),
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','delivered','completed','disputed','refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  amount NUMERIC(18,2) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('topup','purchase','sale','commission','refund','admin_adjustment')),
  reference TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transactions_user_created_idx ON transactions(telegram_id, created_at DESC);

COMMIT;
