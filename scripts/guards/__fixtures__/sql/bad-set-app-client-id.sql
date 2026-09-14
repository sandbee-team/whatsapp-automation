-- Fixture (P14 C5 negative): a plain (non-LOCAL) SET of a custom session
-- variable is exactly the cross-tenant leak class this guard exists to ban
-- and must still be rejected.
SET app.client_id = '00000000-0000-0000-0000-000000000000';
