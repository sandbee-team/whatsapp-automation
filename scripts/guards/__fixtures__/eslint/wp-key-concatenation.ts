/**
 * Fixture: adversarial-evasion attempt for wp/key-construction (session C2).
 *
 * accepted limitation: KEY_ENTRIES matches an ESLint `Literal`/
 * `TemplateLiteral` AST node whose *own* raw text starts with `wp:`. A key
 * built via string concatenation (`'wp' + ':' + ...`) is a `BinaryExpression`
 * at the AST level, not a `Literal` starting with `wp:`, so neither selector
 * can structurally see it. Documented here (not silently uncovered) - a
 * defense-in-depth data-flow rule (e.g. no-restricted-syntax on
 * BinaryExpression building a key), if ever added, is a separate guard.
 */
export const evadedKeyByConcatenation = 'wp' + ':' + 'tenant:123:queue';
