/**
 * broadcast/vars.ts (P23 Unit U2, step 3) - template token extraction plus
 * the freeze-at-snapshot / render-at-send-time resolution pair.
 *
 * `freezeVars` runs ONCE, at audience snapshot time (Phase A of P23's two
 * cursors) - it resolves every `{{token}}` against the contact/group record
 * available at that moment and freezes the result into
 * `campaign_recipients.vars` (jsonb). `renderVars` runs later, at send time,
 * and substitutes ONLY from that frozen `vars` map - never re-reads the
 * template or a live contact record - so a contact edited after the
 * snapshot can never change what was already promised to a recipient.
 *
 * A value only "counts" as present when it is a non-empty string or a
 * finite number (stringified) - `undefined`, `null`, empty string, and
 * non-finite numbers (`NaN`, `Infinity`) are all treated as missing. This
 * is the mechanism that prevents the historical failure mode this phase is
 * built to avoid: a template rendering with a blank space where a variable
 * should have been. Both functions return the FIRST missing token
 * (deterministic, so the same input always reports the same reason) and
 * never partially render - `renderVars` either substitutes everything or
 * fails outright with `missingToken`.
 */

/** Matches `{{ token }}` with optional inner whitespace; token = `[A-Za-z_][A-Za-z0-9_.]*` (dotted attribute paths allowed). */
export const TEMPLATE_TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

export function extractTemplateTokens(body: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of body.matchAll(TEMPLATE_TOKEN_RE)) {
    const token = match[1] as string;
    if (!seen.has(token)) {
      seen.add(token);
      ordered.push(token);
    }
  }
  return ordered;
}

/** Resolves a dotted path (e.g. `'attrs.city'`) against a nested object; returns `undefined` on any missing hop. */
function resolveDotPath(source: Readonly<Record<string, unknown>>, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let cursor: unknown = source;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** A value "counts" as present only when it is a non-empty string or a finite number - stringified for both. */
function resolvePresentValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  return undefined;
}

export function missingVarSkipReason(token: string): string {
  return `missing_var:${token}`;
}

export type FreezeVarsResult =
  { ok: true; vars: Record<string, string> } | { ok: false; missingToken: string };

export function freezeVars(
  body: string,
  source: Readonly<Record<string, unknown>>,
): FreezeVarsResult {
  const tokens = extractTemplateTokens(body);
  const vars: Record<string, string> = {};
  for (const token of tokens) {
    const resolved = resolvePresentValue(resolveDotPath(source, token));
    if (resolved === undefined) {
      return { ok: false, missingToken: token };
    }
    vars[token] = resolved;
  }
  return { ok: true, vars };
}

export type RenderVarsResult = { ok: true; text: string } | { ok: false; missingToken: string };

export function renderVars(body: string, vars: Readonly<Record<string, string>>): RenderVarsResult {
  const tokens = extractTemplateTokens(body);
  for (const token of tokens) {
    const value = vars[token];
    if (value === undefined || value.length === 0) {
      return { ok: false, missingToken: token };
    }
  }

  const text = body.replace(TEMPLATE_TOKEN_RE, (_full, token: string) => vars[token] as string);
  return { ok: true, text };
}
