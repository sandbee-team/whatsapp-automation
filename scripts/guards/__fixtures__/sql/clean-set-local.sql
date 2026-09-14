-- Fixture: SET LOCAL and set_config(..., true) are the accepted forms -
-- this file must stay clean under sql-lint.
SET LOCAL statement_timeout = '5s';
SELECT set_config('app.current_client_id', $1, true);

SELECT id FROM message_jobs WHERE client_id = $1 ORDER BY id LIMIT 20;
