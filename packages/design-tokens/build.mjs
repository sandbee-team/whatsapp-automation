// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import StyleDictionary from 'style-dictionary';

/**
 * `@wp/design-tokens` build (P05 step 1, ADR 0007 / design doc
 * `@wp/design-tokens` section). Reads the DTCG JSON source under
 * `src/tokens/*.tokens.json` via Style Dictionary (reference resolution:
 * `{color.neutral.50}` -> the resolved leaf value) and emits three
 * COMMITTED artifacts:
 *
 *   - `css/tokens.css`      - `:root { --wp-<path>: <value>; }` plus a
 *                             `:root[data-theme="dark"]` block and a
 *                             `prefers-color-scheme: dark` media query for
 *                             the `color.semantic.dark.*` tokens.
 *   - `css/tailwind-theme.css` - Tailwind v4 CSS-first `@theme { ... }`
 *                             block mapping every `color.semantic.light.*`
 *                             token to a `--color-*` Tailwind theme
 *                             variable (and a few non-color theme vars),
 *                             each referencing the `--wp-*` custom property
 *                             so runtime dark-mode overrides keep working.
 *   - `src/tokens.generated.ts` - a frozen JS map of token path -> CSS var
 *                             reference string, for JS/TS consumers.
 *
 * Idempotent: re-running produces byte-identical output (no timestamps, no
 * non-deterministic ordering - tokens are emitted in the stable order
 * `dictionary.allTokens` returns, which Style Dictionary derives from
 * source-file object key order).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS_DIR = path.join(__dirname, 'css');
const SRC_DIR = path.join(__dirname, 'src');

/** DTCG path segments -> CSS custom property name, e.g. ["color","accent","value"] -> "--wp-color-accent-value". */
function cssVarName(tokenPath) {
  return `--wp-${tokenPath.join('-')}`;
}

/** Renders a resolved token $value as CSS-ready text (fontFamily arrays become a quoted, comma-joined stack). */
function cssValue(token) {
  if (Array.isArray(token.$value)) {
    return token.$value.map((entry) => (/\s/.test(entry) ? `"${entry}"` : entry)).join(', ');
  }
  return String(token.$value);
}

function isUnderPath(tokenPath, prefix) {
  return prefix.every((segment, index) => tokenPath[index] === segment);
}

function buildTokensCss(allTokens) {
  const rootLines = [];
  const darkLines = [];

  for (const token of allTokens) {
    // Every leaf token (including color.semantic.dark.*) gets its own
    // literal --wp-<path> custom property in :root, so every DTCG token
    // path resolves to a CSS custom property 1:1 - see
    // tokens-build.test.ts's every_token_reference_resolves_to_a_css_custom_property.
    rootLines.push(`  ${cssVarName(token.path)}: ${cssValue(token)};`);
  }

  const lightByRole = new Map();
  const darkByRole = new Map();
  for (const token of allTokens) {
    if (isUnderPath(token.path, ['color', 'semantic', 'light'])) {
      lightByRole.set(token.path[token.path.length - 1], token);
    }
    if (isUnderPath(token.path, ['color', 'semantic', 'dark'])) {
      darkByRole.set(token.path[token.path.length - 1], token);
    }
  }
  // Theme-switch overrides re-point the LIGHT semantic var name
  // (color.semantic.light.<role>, the one Tailwind's --color-* theme vars
  // reference - see buildTailwindThemeCss) at the dark value, so consumers
  // use one stable custom property name regardless of active theme. The
  // dark tokens' OWN --wp-color-semantic-dark-* names (emitted above in
  // :root) stay theme-invariant, for anything that wants the literal dark
  // value directly.
  for (const [role, darkToken] of darkByRole) {
    const lightToken = lightByRole.get(role);
    if (!lightToken) continue;
    darkLines.push(`  ${cssVarName(lightToken.path)}: ${cssValue(darkToken)};`);
  }

  return `/**
 * GENERATED FILE - do not edit by hand. Run \`pnpm tokens:build\` (source:
 * src/tokens/*.tokens.json) to regenerate.
 */
:root {
${rootLines.join('\n')}
}

:root[data-theme='dark'] {
${darkLines.join('\n')}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${darkLines.map((line) => `  ${line}`).join('\n')}
  }
}
`;
}

/**
 * name -> [duration token name, easing token name, optional fill-mode /
 * iteration suffix] for the `--animate-*` utilities (P26b brief section 2 +
 * panel-refresh spec section 2). The optional fourth element is appended
 * verbatim to the emitted `--animate-*` value (e.g. `both`, `infinite`).
 */
const ANIMATION_SPECS = [
  ['fade-in', 'normal', 'standard'],
  ['fade-out', 'fast', 'standard'],
  ['scale-in', 'normal', 'decelerate'],
  ['slide-in-from-right', 'normal', 'decelerate'],
  ['slide-in-from-bottom', 'normal', 'decelerate'],
  ['shimmer', 'slow', 'standard'],
  ['rise-in', 'slower', 'decelerate', 'both'],
  ['pop-in', 'normal', 'decelerate', 'both'],
  ['float', 'drift', 'standard', 'infinite'],
  ['aurora', 'glacial', 'standard', 'infinite'],
  ['pulse-ring', 'pulse', 'decelerate', 'infinite'],
  ['draw', 'slower', 'decelerate', 'both'],
];

/** @keyframes bodies for the P26b brief's --animate-* utilities, emitted inside the @theme block. */
const KEYFRAMES_CSS = {
  'fade-in': '@keyframes fade-in {\n    from { opacity: 0; }\n    to { opacity: 1; }\n  }',
  'fade-out': '@keyframes fade-out {\n    from { opacity: 1; }\n    to { opacity: 0; }\n  }',
  'scale-in':
    '@keyframes scale-in {\n    from { opacity: 0; transform: scale(0.95); }\n    to { opacity: 1; transform: scale(1); }\n  }',
  'slide-in-from-right':
    '@keyframes slide-in-from-right {\n    from { transform: translateX(8px); opacity: 0; }\n    to { transform: translateX(0); opacity: 1; }\n  }',
  'slide-in-from-bottom':
    '@keyframes slide-in-from-bottom {\n    from { transform: translateY(8px); opacity: 0; }\n    to { transform: translateY(0); opacity: 1; }\n  }',
  shimmer:
    '@keyframes shimmer {\n    from { background-position: 200% 0; }\n    to { background-position: -200% 0; }\n  }',
  'rise-in':
    '@keyframes rise-in {\n    from { opacity: 0; transform: translateY(12px); }\n    to { opacity: 1; transform: none; }\n  }',
  'pop-in':
    '@keyframes pop-in {\n    from { opacity: 0; transform: scale(.92); }\n    to { opacity: 1; transform: none; }\n  }',
  float:
    '@keyframes float {\n    0%, 100% { transform: translateY(0); }\n    50% { transform: translateY(-8px); }\n  }',
  aurora:
    '@keyframes aurora {\n    0% { transform: translate3d(-4%, -2%, 0) rotate(0); }\n    50% { transform: translate3d(4%, 3%, 0) rotate(6deg); }\n    100% { transform: translate3d(-4%, -2%, 0) rotate(0); }\n  }',
  'pulse-ring':
    '@keyframes pulse-ring {\n    0% { transform: scale(1); opacity: .6; }\n    100% { transform: scale(2.2); opacity: 0; }\n  }',
  draw: '@keyframes draw {\n    from { stroke-dashoffset: var(--wp-draw-length, 1000); }\n    to { stroke-dashoffset: 0; }\n  }',
};

function buildTailwindThemeCss(allTokens) {
  const lines = [];

  for (const token of allTokens) {
    if (isUnderPath(token.path, ['color', 'semantic', 'light'])) {
      const role = token.path[token.path.length - 1];
      lines.push(`  --color-${role}: var(${cssVarName(token.path)});`);
    }
  }

  const fontUi = allTokens.find((token) => token.path.join('.') === 'font.ui');
  const fontMono = allTokens.find((token) => token.path.join('.') === 'font.mono');
  if (fontUi) lines.push(`  --font-ui: var(${cssVarName(fontUi.path)});`);
  if (fontMono) lines.push(`  --font-mono: var(${cssVarName(fontMono.path)});`);

  for (const token of allTokens) {
    if (isUnderPath(token.path, ['text'])) {
      const size = token.path[1];
      const field = token.path[2];
      if (field === 'size') {
        lines.push(`  --text-${size}: var(${cssVarName(token.path)});`);
      } else if (field === 'lineHeight') {
        lines.push(`  --text-${size}--line-height: var(${cssVarName(token.path)});`);
      }
    }
    if (isUnderPath(token.path, ['shadow'])) {
      lines.push(`  --shadow-${token.path[1]}: var(${cssVarName(token.path)});`);
    }
    if (isUnderPath(token.path, ['motion', 'easing'])) {
      lines.push(`  --ease-${token.path[2]}: var(${cssVarName(token.path)});`);
    }
    if (isUnderPath(token.path, ['radius'])) {
      lines.push(`  --radius-${token.path[1]}: var(${cssVarName(token.path)});`);
    }
    if (isUnderPath(token.path, ['space'])) {
      lines.push(`  --spacing-${token.path[1]}: var(${cssVarName(token.path)});`);
    }
  }

  for (const [name, durationName, easingName, suffix] of ANIMATION_SPECS) {
    const base = `${name} var(--wp-motion-duration-${durationName}) var(--wp-motion-easing-${easingName})`;
    lines.push(`  --animate-${name}: ${suffix ? `${base} ${suffix}` : base};`);
  }
  for (const [, keyframes] of Object.entries(KEYFRAMES_CSS)) {
    lines.push(`  ${keyframes}`);
  }

  return `/**
 * GENERATED FILE - do not edit by hand. Run \`pnpm tokens:build\` to
 * regenerate. Tailwind v4 CSS-first theme mapping (this file IS the
 * "Tailwind preset") - import alongside css/tokens.css.
 */
@theme {
${lines.join('\n')}
}
`;
}

function toCamel(segment) {
  return segment.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

/** Builds a nested plain-object tree (token path -> `var(--wp-...)` leaf) for the generated TS module. */
function buildTokenTree(allTokens) {
  const tree = {};
  for (const token of allTokens) {
    if (isUnderPath(token.path, ['color', 'semantic', 'dark'])) {
      // Dark values are theme overrides of the same custom property, not a
      // separate JS-visible token - see buildTokensCss.
      continue;
    }
    let cursor = tree;
    const camelPath = token.path.map(toCamel);
    for (let i = 0; i < camelPath.length - 1; i += 1) {
      const key = camelPath[i];
      cursor[key] = cursor[key] ?? {};
      cursor = cursor[key];
    }
    cursor[camelPath[camelPath.length - 1]] = `var(${cssVarName(token.path)})`;
  }
  return tree;
}

function buildGeneratedTs(allTokens) {
  const tree = buildTokenTree(allTokens);
  return `/**
 * GENERATED FILE - do not edit by hand. Run \`pnpm tokens:build\` to
 * regenerate (source: src/tokens/*.tokens.json).
 */

const rawTokens = ${JSON.stringify(tree, null, 2)} as const;

export const tokens = Object.freeze(rawTokens);

/** Path to the committed CSS custom-property output, relative to this package's root. */
export const TOKEN_CSS_PATH = './css/tokens.css' as const;

/** Path to the committed Tailwind v4 theme mapping, relative to this package's root. */
export const TAILWIND_THEME_CSS_PATH = './css/tailwind-theme.css' as const;
`;
}

async function main() {
  const sd = new StyleDictionary({
    source: [path.join(SRC_DIR, 'tokens', '*.tokens.json').split(path.sep).join('/')],
    platforms: {
      // No transforms registered: source $type/$value pass through
      // untouched (OKLCH/rem/ms strings are already CSS-ready) - this
      // platform exists only so Style Dictionary resolves `{a.b.c}`
      // references for us via getPlatformTokens below.
      wp: {},
    },
  });
  await sd.hasInitialized;

  const dictionary = await sd.getPlatformTokens('wp', {});

  const allTokens = dictionary.allTokens;

  mkdirSync(CSS_DIR, { recursive: true });
  writeFileSync(path.join(CSS_DIR, 'tokens.css'), buildTokensCss(allTokens));
  writeFileSync(path.join(CSS_DIR, 'tailwind-theme.css'), buildTailwindThemeCss(allTokens));
  writeFileSync(path.join(SRC_DIR, 'tokens.generated.ts'), buildGeneratedTs(allTokens));

  console.log(
    `tokens:build - ${String(allTokens.length)} tokens -> css/tokens.css, css/tailwind-theme.css, src/tokens.generated.ts`,
  );
}

main();
