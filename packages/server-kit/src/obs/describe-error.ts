/**
 * Reduces an arbitrary caught value to a short, safe-to-log summary: the
 * error's `name`, plus a `code` (pg SQLSTATE like `23505`, Node errno like
 * `EADDRINUSE`) and/or a numeric `status`/`statusCode` when present.
 *
 * Deliberately NEVER includes `message`, `detail`, `where`, `internalQuery`,
 * `hint`, `schema`, `table`, `column`, or `constraint` - a pg `DatabaseError`
 * routinely embeds the offending row's data in several of those fields (e.g.
 * `detail: 'Key (email)=(user@example.com) already exists.'`), so the only
 * safe fields to log are the ones that identify the error CLASS, never its
 * content. This is the one function every log/error-interpolation call site
 * in the workspace must route through instead of `String(err)`/`err.message`.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    return typeof err;
  }

  const withCode = err as { code?: unknown };
  const withStatus = err as { statusCode?: unknown; status?: unknown };

  let summary = err.name;

  const code = withCode.code;
  if (typeof code === 'string' || typeof code === 'number') {
    summary += ` (${String(code)})`;
  }

  const status = withStatus.statusCode ?? withStatus.status;
  if (typeof status === 'number') {
    summary += ` [${String(status)}]`;
  }

  return summary;
}
