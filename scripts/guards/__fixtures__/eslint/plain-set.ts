/**
 * Fixture: wp/no-plain-set (P00 step 5).
 *
 * BAD: a plain, session-scoped SET. Under transaction pooling a session-scoped
 * SET leaks across tenants that share the pooled connection.
 * GOOD: SET LOCAL (transaction-scoped) and set_config(key, value, true) are
 * the only accepted forms.
 */
export const badSetLiteral = 'SET search_path = tenant_1';
export const badSetTemplate = `SET search_path = ${'tenant_1'}`;

export const goodSetLocal = 'SET LOCAL search_path = tenant_1';
export const goodSetConfigLiteral = "SELECT set_config('app.tenant_id', $1, true)";
