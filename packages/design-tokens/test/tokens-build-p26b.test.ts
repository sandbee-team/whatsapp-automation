import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Proves the P26b design brief's role table and non-color theme scales
 * (docs/design/P26b-design-brief.md section 2) are present in the generated
 * artifacts, and that the build stays idempotent and hex-free. Split out of
 * tokens-build.test.ts to respect the 300-line file cap.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TOKENS_DIR = path.join(PACKAGE_ROOT, 'src', 'tokens');
const TOKENS_CSS_PATH = path.join(PACKAGE_ROOT, 'css', 'tokens.css');
const TAILWIND_THEME_CSS_PATH = path.join(PACKAGE_ROOT, 'css', 'tailwind-theme.css');
const GENERATED_TS_PATH = path.join(PACKAGE_ROOT, 'src', 'tokens.generated.ts');

const BRIEF_ROLES = [
  'bg',
  'surface',
  'surface-2',
  'surface-3',
  'fg',
  'muted',
  'subtle',
  'border',
  'border-strong',
  'ring',
  'accent',
  'accent-hover',
  'accent-fg',
  'accent-soft',
  'success',
  'success-soft',
  'warning',
  'warning-soft',
  'danger',
  'danger-hover',
  'danger-soft',
  'info',
  'info-soft',
  'sidebar',
  'sidebar-fg',
  'sidebar-muted',
  'sidebar-border',
  'sidebar-active',
  'sidebar-active-fg',
  'overlay',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
] as const;

interface SemanticColorTokens {
  color: { semantic: { light: Record<string, unknown>; dark: Record<string, unknown> } };
}

function loadSemanticColor(): SemanticColorTokens {
  return JSON.parse(
    readFileSync(path.join(TOKENS_DIR, 'color.tokens.json'), 'utf8'),
  ) as SemanticColorTokens;
}

describe('P26b brief role table', () => {
  it('every_brief_role_exists_as_a_light_and_dark_semantic_source_token', () => {
    const semanticColor = loadSemanticColor();
    for (const role of BRIEF_ROLES) {
      expect(semanticColor.color.semantic.light, `missing light.${role}`).toHaveProperty(role);
      expect(semanticColor.color.semantic.dark, `missing dark.${role}`).toHaveProperty(role);
    }
  });

  it('every_brief_role_appears_in_tokens_css_root_dark_and_media_query_blocks', () => {
    const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
    const rootMatch = /:root \{([\s\S]*?)\n\}/.exec(css);
    const darkMatch = /:root\[data-theme='dark'\] \{([\s\S]*?)\n\}/.exec(css);
    const mediaMatch = /@media \(prefers-color-scheme: dark\) \{([\s\S]*)\}\n$/.exec(css);
    expect(rootMatch, ':root block not found').not.toBeNull();
    expect(darkMatch, "[data-theme='dark'] block not found").not.toBeNull();
    expect(mediaMatch, 'prefers-color-scheme media block not found').not.toBeNull();

    for (const role of BRIEF_ROLES) {
      const varName = `--wp-color-semantic-light-${role}`;
      expect(rootMatch?.[1], `:root missing ${varName}`).toContain(`${varName}:`);
      expect(darkMatch?.[1], `dark block missing override for ${varName}`).toContain(`${varName}:`);
      expect(mediaMatch?.[1], `media block missing override for ${varName}`).toContain(
        `${varName}:`,
      );
    }
  });

  it('every_brief_role_is_a_tailwind_color_utility', () => {
    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    for (const role of BRIEF_ROLES) {
      expect(tailwindCss, `missing --color-${role} in tailwind-theme.css`).toContain(
        `--color-${role}:`,
      );
    }
  });

  it('exact_oklch_values_for_representative_roles', () => {
    // Resolved values (post reference-resolution) are asserted against the
    // generated CSS, since a role's source $value may be a `{color.a.b}`
    // reference (e.g. light.accent) rather than a literal.
    const css = readFileSync(TOKENS_CSS_PATH, 'utf8');

    expect(css).toContain('--wp-color-semantic-light-accent: oklch(0.55 0.15 150);');
    expect(css).toContain('--wp-color-semantic-dark-accent: oklch(0.72 0.16 150);');
    expect(css).toContain('--wp-color-semantic-light-bg: oklch(0.985 0.002 250);');
    expect(css).toContain('--wp-color-semantic-dark-bg: oklch(0.13 0.006 250);');
    expect(css).toContain('--wp-color-semantic-light-sidebar-active-fg: oklch(0.35 0.12 150);');
    expect(css).toContain('--wp-color-semantic-dark-sidebar-active-fg: oklch(0.85 0.12 150);');
  });

  it('chart_dark_values_are_light_lightness_plus_0_12', () => {
    const semanticColor = loadSemanticColor();
    const light = semanticColor.color.semantic.light as Record<string, { $value: string }>;
    const dark = semanticColor.color.semantic.dark as Record<string, { $value: string }>;

    const OKLCH_RE = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/;
    for (let index = 1; index <= 5; index += 1) {
      const role = `chart-${String(index)}`;
      const lightMatch = OKLCH_RE.exec(light[role].$value);
      const darkMatch = OKLCH_RE.exec(dark[role].$value);
      expect(lightMatch, `light.${role} not a plain oklch() literal`).not.toBeNull();
      expect(darkMatch, `dark.${role} not a plain oklch() literal`).not.toBeNull();
      const lightL = Number(lightMatch?.[1]);
      const darkL = Number(darkMatch?.[1]);
      expect(darkL).toBeCloseTo(lightL + 0.12, 5);
      // Chroma and hue are unchanged by the +0.12 L lighten rule.
      expect(darkMatch?.[2]).toBe(lightMatch?.[2]);
      expect(darkMatch?.[3]).toBe(lightMatch?.[3]);
    }
  });
});

describe('P26b brief non-color theme scales', () => {
  it('emits_the_full_type_scale_with_paired_line_heights', () => {
    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    const sizes = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'];
    for (const size of sizes) {
      expect(tailwindCss, `missing --text-${size}`).toContain(`--text-${size}:`);
      expect(tailwindCss, `missing --text-${size}--line-height`).toContain(
        `--text-${size}--line-height:`,
      );
    }
  });

  it('exact_type_scale_px_values', () => {
    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    const expected: Record<string, [string, string]> = {
      xs: ['12px', '16px'],
      sm: ['13px', '20px'],
      base: ['14px', '20px'],
      lg: ['16px', '24px'],
      xl: ['18px', '26px'],
      '2xl': ['22px', '28px'],
      '3xl': ['28px', '34px'],
      '4xl': ['34px', '40px'],
    };
    for (const [size, [fontSize, lineHeight]] of Object.entries(expected)) {
      const sizeMatch = new RegExp(`--text-${size}:\\s*var\\((--wp-[a-zA-Z0-9-]+)\\);`).exec(
        tailwindCss,
      );
      expect(sizeMatch, `--text-${size} missing`).not.toBeNull();
      const lineHeightMatch = new RegExp(
        `--text-${size}--line-height:\\s*var\\((--wp-[a-zA-Z0-9-]+)\\);`,
      ).exec(tailwindCss);
      expect(lineHeightMatch, `--text-${size}--line-height missing`).not.toBeNull();

      const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');
      expect(tokensCss).toContain(`${sizeMatch?.[1]}: ${fontSize};`);
      expect(tokensCss).toContain(`${lineHeightMatch?.[1]}: ${lineHeight};`);
    }
  });

  it('emits_shadow_scale_including_card', () => {
    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    for (const key of ['sm', 'md', 'lg', 'card', 'elevated']) {
      expect(tailwindCss, `missing --shadow-${key}`).toContain(`--shadow-${key}:`);
    }
  });

  it('softens_the_card_shadow_and_adds_elevated_per_the_panel_refresh_spec', () => {
    const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');
    expect(tokensCss).toContain(
      '--wp-shadow-card: 0 1px 2px oklch(0 0 0 / 0.04), 0 0 0 1px oklch(0 0 0 / 0.025);',
    );
    expect(tokensCss).toContain('--wp-shadow-elevated: 0 12px 32px -12px oklch(0 0 0 / 0.18);');
  });

  it('emits_easing_scale', () => {
    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    for (const key of ['standard', 'decelerate', 'accelerate']) {
      expect(tailwindCss, `missing --ease-${key}`).toContain(`--ease-${key}:`);
    }
  });

  it('emits_animate_utilities_with_paired_keyframes_inside_theme_block', () => {
    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    const themeMatch = /@theme \{([\s\S]*)\n\}\n$/.exec(tailwindCss);
    expect(themeMatch, '@theme block not found').not.toBeNull();
    const themeBody = themeMatch?.[1] ?? '';

    const animations = [
      'fade-in',
      'fade-out',
      'scale-in',
      'slide-in-from-right',
      'slide-in-from-bottom',
      'shimmer',
      'rise-in',
      'pop-in',
      'float',
      'aurora',
      'pulse-ring',
      'draw',
    ];
    for (const name of animations) {
      expect(themeBody, `missing --animate-${name}`).toContain(`--animate-${name}:`);
      expect(themeBody, `missing @keyframes ${name}`).toContain(`@keyframes ${name} {`);
    }

    expect(themeBody).toContain(
      '--animate-fade-in: fade-in var(--wp-motion-duration-normal) var(--wp-motion-easing-standard);',
    );
    expect(themeBody).toContain(
      '--animate-fade-out: fade-out var(--wp-motion-duration-fast) var(--wp-motion-easing-standard);',
    );
  });

  it('emits_the_panel_refresh_motion_utilities_with_their_fill_mode_iteration_suffixes', () => {
    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    const themeMatch = /@theme \{([\s\S]*)\n\}\n$/.exec(tailwindCss);
    const themeBody = themeMatch?.[1] ?? '';

    // [name, duration token, easing token, fill-mode/iteration suffix].
    const specs: [string, string, string, string][] = [
      ['rise-in', 'slower', 'decelerate', 'both'],
      ['pop-in', 'normal', 'decelerate', 'both'],
      ['float', 'drift', 'standard', 'infinite'],
      ['aurora', 'glacial', 'standard', 'infinite'],
      ['pulse-ring', 'pulse', 'decelerate', 'infinite'],
      ['draw', 'slower', 'decelerate', 'both'],
    ];
    for (const [name, duration, easing, suffix] of specs) {
      const line = `--animate-${name}: ${name} var(--wp-motion-duration-${duration}) var(--wp-motion-easing-${easing}) ${suffix};`;
      expect(themeBody, `missing exact --animate-${name} line`).toContain(line);
    }
  });

  it('emits_the_new_motion_durations', () => {
    const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');
    expect(tokensCss).toContain('--wp-motion-duration-slower: 600ms;');
    expect(tokensCss).toContain('--wp-motion-duration-pulse: 1800ms;');
    expect(tokensCss).toContain('--wp-motion-duration-drift: 6s;');
    expect(tokensCss).toContain('--wp-motion-duration-glacial: 12s;');
  });

  it('keeps_radius_and_spacing_scales', () => {
    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    for (const key of ['sm', 'md', 'lg', 'xl', 'full']) {
      expect(tailwindCss).toContain(`--radius-${key}:`);
    }
    for (const key of ['0', '1', '2', '3', '4', '5', '6', '8', '10', '12', '16']) {
      expect(tailwindCss).toContain(`--spacing-${key}:`);
    }
  });
});

describe('P26b build idempotency and hex ban', () => {
  it('rebuilding_is_byte_identical', () => {
    execFileSync('node', [path.join(PACKAGE_ROOT, 'build.mjs')], { cwd: PACKAGE_ROOT });
    const tokensCssFirst = readFileSync(TOKENS_CSS_PATH, 'utf8');
    const tailwindCssFirst = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    const generatedTsFirst = readFileSync(GENERATED_TS_PATH, 'utf8');

    execFileSync('node', [path.join(PACKAGE_ROOT, 'build.mjs')], { cwd: PACKAGE_ROOT });
    const tokensCssSecond = readFileSync(TOKENS_CSS_PATH, 'utf8');
    const tailwindCssSecond = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    const generatedTsSecond = readFileSync(GENERATED_TS_PATH, 'utf8');

    expect(tokensCssSecond).toBe(tokensCssFirst);
    expect(tailwindCssSecond).toBe(tailwindCssFirst);
    expect(generatedTsSecond).toBe(generatedTsFirst);
  }, 30_000); // two full builds; 5 s flaked under a parallel vitest run

  it('no_hex_literal_in_generated_css', () => {
    const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf8');
    const tailwindCss = readFileSync(TAILWIND_THEME_CSS_PATH, 'utf8');
    expect(tokensCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(tailwindCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
