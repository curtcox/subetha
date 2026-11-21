-- Auto-recharge (PLAN §8 rule 1): a saved card, topped up off-session when the balance is low.
ALTER TABLE accounts ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE accounts ADD COLUMN auto_recharge TEXT; -- JSON {threshold_micros, amount_micros} or NULL
