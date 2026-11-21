-- Payment intents credited to accounts, so disputes and refunds can be traced back and
-- partial refunds deducted only once.
CREATE TABLE stripe_payments (
  payment_intent TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  refunded_micros INTEGER NOT NULL DEFAULT 0,
  disputed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
