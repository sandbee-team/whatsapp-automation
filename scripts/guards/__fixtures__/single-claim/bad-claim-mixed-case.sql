-- Fixture (P09 debugger fix): mixed/upper keyword casing on the column name
-- itself (STATUS) combined with lowercase update/set keywords - must still
-- flag under the case-insensitive, clause-bound pattern.
Update message_jobs
   Set STATUS = 'processing'
 Where id = $1;
