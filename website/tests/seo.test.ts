import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { organizationJsonLd, serializeJsonLd } from '../src/lib/seo.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = path.resolve(TEST_DIR, '..');

/**
 * seo.test.ts (P29a step 7) - the JSON-LD embed is the one sanctioned
 * `dangerouslySetInnerHTML` on the site; this pins the sanitizer that makes
 * it safe and that the layout actually uses it (a raw `JSON.stringify` there
 * is the exact defect the semgrep rule `wp.no-dangerously-set-inner-html-
 * dynamic` flagged on 2026-09-09).
 */
describe('website JSON-LD serialisation (P29a step 7)', () => {
  it('serializeJsonLd_escapes_every_script_break_out_character_and_stays_valid_json', () => {
    const hostile = {
      name: '</script><script>alert(1)</script>',
      note: 'a & b > c < d\u2028line\u2029sep',
    };
    const out = serializeJsonLd(hostile);

    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('&');
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
    expect(out).toBe(
      '{"name":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e","note":"a \\u0026 b \\u003e c \\u003c d\\u2028line\\u2029sep"}',
    );
    expect(JSON.parse(out)).toEqual(hostile);
  });

  it('the_layout_embeds_json_ld_only_through_the_sanitizer', () => {
    const layout = readFileSync(path.join(WEBSITE_ROOT, 'src', 'app', 'layout.tsx'), 'utf8');
    expect(layout).toContain('__html: serializeJsonLd(organizationJsonLd())');
    expect(layout).not.toMatch(/__html:\s*JSON\.stringify/);

    const jsonLd = organizationJsonLd();
    expect(jsonLd['@type']).toBe('Organization');
    expect(JSON.parse(serializeJsonLd(jsonLd))).toEqual(jsonLd);
  });
});
