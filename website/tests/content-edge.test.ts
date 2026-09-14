import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { getDoc, getLegal, listDocs } from '../src/lib/content.js';

/**
 * content-edge.test.ts (P29 session 1, E3 hardening) - path-escape safety,
 * empty-directory behavior, and frontmatter-validation edge cases for the
 * content pipeline beyond `content.test.ts`.
 */

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wp-content-edge-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('content_pipeline_path_escape_safety', () => {
  it('a_slug_containing_dotdot_never_escapes_the_content_root_and_is_not_found', () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    mkdirSync(path.join(root, 'legal'), { recursive: true });
    writeFileSync(
      path.join(root, 'legal', 'terms.mdx'),
      '---\ntitle: Terms\ndescription: The terms\n---\nbody',
    );

    // getDoc builds its lookup slug by joining the parts with "/" and
    // matching against slugs derived from actual files under docs/ - a
    // slug string containing ".." never causes a filesystem read outside
    // docsRoot because listDocs only ever reads files it discovered by
    // walking docsRoot itself. The lookup simply finds no match.
    expect(() => getDoc(['..', 'legal', 'terms'], root)).toThrow();
  });

  it('a_slug_containing_a_backslash_is_not_found_never_reads_outside_root', () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    expect(() => getDoc(['..\\legal\\terms'], root)).toThrow();
  });

  it('a_slug_with_a_trailing_slash_segment_is_not_found', () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, 'docs', 'guide'), { recursive: true });
    writeFileSync(
      path.join(root, 'docs', 'guide', 'index.mdx'),
      '---\ntitle: Guide\ndescription: A guide\n---\nbody',
    );
    // Real slug is "guide/index"; a trailing-empty segment produces
    // "guide/index/" which does not match any discovered slug.
    expect(() => getDoc(['guide', 'index', ''], root)).toThrow();
  });
});

describe('content_pipeline_empty_and_frontmatter_edge_cases', () => {
  it('listDocs_on_an_empty_temp_dir_returns_an_empty_array', () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    expect(listDocs(root)).toEqual([]);
  });

  it('a_frontmatter_with_title_but_empty_description_throws', () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(
      path.join(root, 'docs', 'bad.mdx'),
      '---\ntitle: Has a title\ndescription: ""\n---\nbody',
    );
    expect(() => listDocs(root)).toThrow(/description/);
  });

  it('a_non_mdx_md_file_is_ignored_by_the_walker', () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'ignored.md'), '# not mdx, no frontmatter needed');
    writeFileSync(
      path.join(root, 'docs', 'included.mdx'),
      '---\ntitle: Included\ndescription: This one counts\n---\nbody',
    );
    const docs = listDocs(root);
    expect(docs.map((d) => d.meta.slug)).toEqual(['included']);
  });

  it('getLegal_on_a_missing_kind_throws_a_not_found_error_not_the_raw_enoent', () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, 'legal'), { recursive: true });
    expect(() => getLegal('terms', root)).toThrow(/No legal document found/);
  });
});
