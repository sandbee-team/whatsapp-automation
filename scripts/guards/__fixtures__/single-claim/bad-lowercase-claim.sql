-- Fixture (finding 4c, P03 close): same claim shape as bad-claim.sql but
-- with lowercase SQL keywords - proves the guard's case-insensitivity fix
-- (LITERAL_STATUS_PATTERN's `i` flag) still catches a bypass that simply
-- avoids the codebase's usual uppercase SQL keyword convention.
update message_jobs
   set status = 'processing'
 where id = $1;
