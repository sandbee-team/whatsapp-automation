-- Fixture (P03 close, finding 2b): a second claim-style UPDATE where a `--`
-- line comment between UPDATE and SET contains a `;` character. The
-- [^;]-bounded gap must not be defeated by a semicolon that lives inside a
-- comment, not at a real statement boundary.
UPDATE message_jobs -- note; here
   SET status = 'processing'
 WHERE id = $1;
