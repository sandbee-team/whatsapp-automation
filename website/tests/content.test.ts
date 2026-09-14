import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDoc, getLegal, listDocs, listPosts } from '../src/lib/content.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_ROOT = path.resolve(TEST_DIR, '..', 'content');

describe('website content pipeline (P29 step 3)', () => {
  it('every_doc_and_post_has_frontmatter_title_and_description', () => {
    const docs = listDocs(CONTENT_ROOT);
    const posts = listPosts(CONTENT_ROOT);
    expect(docs.length).toBeGreaterThan(0);
    expect(posts.length).toBeGreaterThan(0);
    for (const entry of [...docs, ...posts]) {
      expect(entry.meta.title.length).toBeGreaterThan(0);
      expect(entry.meta.description.length).toBeGreaterThan(0);
    }
    for (const kind of ['terms', 'privacy', 'dpa'] as const) {
      const legal = getLegal(kind, CONTENT_ROOT);
      expect(legal.meta.title.length).toBeGreaterThan(0);
      expect(legal.meta.description.length).toBeGreaterThan(0);
    }
  });

  it('the_six_required_operational_docs_exist', () => {
    const slugs = listDocs(CONTENT_ROOT).map((entry) => entry.meta.slug);
    expect(slugs).toContain('how-sending-is-paced');
    expect(slugs).toContain('what-safe-mode-does-and-does-not-do');
    expect(slugs).toContain('what-broadcast-means');
    expect(slugs).toContain('groups-and-why-they-are-capped');
    expect(slugs).toContain('parked-numbers');
    expect(slugs).toContain('wallet-and-billing');
    expect(slugs).toContain('hi/safe-mode');

    const hiDoc = getDoc(['hi', 'safe-mode'], CONTENT_ROOT);
    expect(hiDoc.meta.lang).toBe('hi');
  });

  it('a_missing_slug_throws_instead_of_rendering_empty', () => {
    expect(() => getDoc(['nope'], CONTENT_ROOT)).toThrow();
  });

  it('docs_are_ordered_by_frontmatter_order', () => {
    const englishOrders = listDocs(CONTENT_ROOT)
      .filter((entry) => entry.meta.lang === 'en')
      .map((entry) => entry.meta.order);
    expect(englishOrders).toStrictEqual([1, 2, 3, 4, 5, 6]);
  });
});
