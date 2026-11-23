-- Subscription-level pause/mute toggle (PLAN §3, §5, §9).
ALTER TABLE subscriptions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
