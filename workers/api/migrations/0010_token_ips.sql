-- API tokens can be restricted to client IPs (PLAN §9): a JSON array of IPv4/IPv6 addresses or
-- CIDR ranges, matched against CF-Connecting-IP. NULL = any address.
ALTER TABLE tokens ADD COLUMN ips TEXT;
