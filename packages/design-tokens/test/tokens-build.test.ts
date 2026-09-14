import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Proves the generated CSS/Tailwind-theme outputs (`css/tokens.css`,
 * `css/tailwind-theme.css`, committed, built by `pnpm tokens:build`) are
 * complete and reference-free (ADR 0007, design doc `@wp/design-tokens`
 * section, P05 phase step 1). Walks the DTCG source in `src/tokens/*.tokens.json`
 * recursively to collect every leaf token path, independent of the build
 * tool's own internals.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TOKENS_DIR = path.join(PACKAGE_ROOT, 'src', 'tokens');
const TOKENS_CSS_PATH = path.join(PACKAGE_ROOT, 'css', 'tokens.css');
const TAILWIND_THEME_CSS_PATH = path.join(PACKAGE_ROOT, 'css', 'tailwind-theme.css');

interface TokenLeaf {
  path: string[];
  value: unknown;
}

/** A DTCG leaf node has a `$value` key; everything else is a group to recurse into. */
function collectLeaves(node: unknown, prefix: string[] = [], out: TokenLeaf[] = []): TokenLeaf[] {
  if (node === null || typeof node !== 'object') {
    return out;
  }
  const record = node as Record<string, unknown>;
  if ('$value' in record) {
    out.push({ path: prefix, value: record.$value });
    return out;
  }
  for (const [key, child] of Object.entries(record)) {
    if (key.startsWith('$')) continue;
    collectLeaves(child, [...prefix, key], out);
  }
  return out;
}

function loadAllLeaves(): TokenLeaf[] {
  const files = readdirSync(TOKENS_DIR).filter((file) => file.endsWith('.tokens.json'));
  expect(files.length).toBeGreaterThan(0);

  const leaves: TokenLeaf[] = [];
  for (const file of files) {
    const json = JSON.parse(readFileSync(path.join(TOKENS_DIR, file), 'utf8')) as unknown;
    collectLeaves(json, [], leaves);
  }
  return leaves;
}

/** DTCG path segments -> CSS custom property name, e.g. ["color","accent","value"] -> "--wp-color-accent-value". */
function toCssVarName(tokenPath: string[]): string {
  return `--wp-${tokenPath.join('-')}`;
}

describe('design tokens build output', () => {
  it('every_token_reference_resolves_to_a_css_custom_property', () => {
    const leaves = loadAllLeaves();
    const css = readFileSync(TOKENS_CSS_PATH, 'utf8');

    for (const leaf of leaves) {
      const varName = toCssVarName(leaf.path);
      expect(
        css,
        `missing CSS custom property ${varName} for token ${leaf.path.join('.')}`,
      ).toContain(`${varName}:`);
    }

    // No unresolved DTCG token reference ("{...}") text remains anywhere in the CSS.
    expect(css).not.toMatch(/\{[a-zA-Z]/);
  });

  it('the_font_stack_includes_a_devanagari_fallback', () => {
    const typography = JSON.parse(
      readFileSync(path.join(TOKENS_DIR, 'typography.tokens.json'), 'utf8'),
    ) as { font: { ui: { $value: string[] } } };

    expect(typography.font.ui.$value).toContain('Noto Sans Devanagari');

    const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
    const match = /--wp-font-ui:\s*([^;]+);/.exec(css);
    expect(match, 'no --wp-font-ui custom property found in tokens.css').not.toBeNull();
    expect(match?.[1]).toContain('Noto Sans Devanagari');
  });

  it('the_tailwind_theme_maps_every_semantic_colour', () => {
    const semanticColor = JSON.parse(
      readFileSync(path.join(TOKENS_DIR, 'color.tokens.json'), 'utf8'),
    ) as { color: { semantic: { light: Record<string, unknown> } } };

    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');

    for (const key of Object.keys(semanticColor.color.semantic.light)) {
      expect(
        tailwindCss,
        `missing --color-${key} mapping in tailwind-theme.css for semantic token "${key}"`,
      ).toContain(`--color-${key}:`);
    }
  });
});
