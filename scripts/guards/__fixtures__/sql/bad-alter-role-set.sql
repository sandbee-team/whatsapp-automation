-- Fixture (P03 close, finding 1): ALTER ROLE ... SET is a persistent
-- cross-session default, worse than the plain session SET this guard
-- already bans - must be rejected, not exempted by a bare ALTER match.
ALTER ROLE wp_app SET search_path = public;
