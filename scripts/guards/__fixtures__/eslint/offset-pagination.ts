/**
 * Fixture: wp/no-offset-pagination (P00 step 5).
 *
 * BAD: OFFSET pagination, in raw SQL (literal/template) and via the Drizzle
 * `.offset()` query builder call. Lists are keyset-paginated in this codebase.
 * GOOD: keyset (cursor) pagination - `WHERE id > $1 ORDER BY id LIMIT n`.
 */
export const badOffsetLiteral = 'SELECT * FROM message_jobs ORDER BY id LIMIT 20 OFFSET 40';
export const badOffsetTemplate = `SELECT * FROM message_jobs LIMIT ${20} OFFSET ${40}`;

interface QueryBuilder {
  offset(n: number): QueryBuilder;
}

export function badOffsetBuilder(query: QueryBuilder): QueryBuilder {
  return query.offset(40);
}

export const goodKeysetLiteral = 'SELECT * FROM message_jobs WHERE id > $1 ORDER BY id LIMIT 20';
