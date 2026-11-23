-- Receipts (GET /v1/payments/{id}/receipt) show the fee charged when the payment was credited,
-- even if the fee schedule changes later; and whether it was a Checkout top-up or auto-recharge.
ALTER TABLE stripe_payments ADD COLUMN fee_micros INTEGER;
ALTER TABLE stripe_payments ADD COLUMN kind TEXT;
