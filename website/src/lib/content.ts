import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

/**
 * content.ts (P29 U3) - filesystem content pipeline for docs/blog/legal.
 * Reads MDX files at build time only (no CMS process, no network call).
 * Frontmatter is validated by hand: a bad file throws at build time rather
 * than rendering an empty page (core invariant 6: no silent, misleading
 * surface).
 */
export interface ContentMeta {
  slug: string;
  title: string;
  description: string;
  order?: number;
  date?: string;
  lang: 'en' | 'hi';
}

export interface ContentEntry {
  meta: ContentMeta;
  body: string;
}

const DEFAULT_ROOT = (): string => path.join(process.cwd(), 'content');

function assertNonEmptyString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${filePath}: frontmatter "${field}" must be a non-empty string`);
  }
  return value;
}

function toLang(value: unknown, filePath: string): 'en' | 'hi' {
  if (value === undefined) return 'en';
  if (value === 'en' || value === 'hi') return value;
  throw new Error(`${filePath}: frontmatter "lang" must be "en" or "hi" if present`);
}

function parseMeta(filePath: string, slug: string, data: Record<string, unknown>): ContentMeta {
  const title = assertNonEmptyString(data['title'], 'title', filePath);
  const description = assertNonEmptyString(data['description'], 'description', filePath);
  const lang = toLang(data['lang'], filePath);
  const meta: ContentMeta = { slug, title, description, lang };
  if (typeof data['order'] === 'number') meta.order = data['order'];
  if (typeof data['date'] === 'string') meta.date = data['date'];
  return meta;
}

function readMdxFile(filePath: string, slug: string): ContentEntry {
  const raw = readFileSync(filePath, 'utf8');
  const { data, content } = matter(raw);
  return { meta: parseMeta(filePath, slug, data), body: content };
}

/** Recursively lists every `.mdx` file under `dir`, returning absolute paths. */
function walkMdxFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...walkMdxFiles(full));
    } else if (entry.endsWith('.mdx')) {
      files.push(full);
    }
  }
  return files;
}

/** posix-style slug parts (directory segments + filename, no extension). */
function slugPartsFor(root: string, filePath: string): string[] {
  const relative = path.relative(root, filePath).replace(/\.mdx$/, '');
  return relative.split(path.sep);
}

function compareDocs(a: ContentEntry, b: ContentEntry): number {
  const orderA = a.meta.order ?? Number.MAX_SAFE_INTEGER;
  const orderB = b.meta.order ?? Number.MAX_SAFE_INTEGER;
  if (orderA !== orderB) return orderA - orderB;
  return a.meta.title.localeCompare(b.meta.title);
}

export function listDocs(root: string = DEFAULT_ROOT()): ContentEntry[] {
  const docsRoot = path.join(root, 'docs');
  const files = walkMdxFiles(docsRoot);
  const entries = files.map((filePath) =>
    readMdxFile(filePath, slugPartsFor(docsRoot, filePath).join('/')),
  );
  return entries.sort(compareDocs);
}

export function getDoc(slugParts: string[], root: string = DEFAULT_ROOT()): ContentEntry {
  const slug = slugParts.join('/');
  const doc = listDocs(root).find((entry) => entry.meta.slug === slug);
  if (!doc) throw new Error(`No doc found for slug "${slug}"`);
  return doc;
}

export function listPosts(root: string = DEFAULT_ROOT()): ContentEntry[] {
  const blogRoot = path.join(root, 'blog');
  const files = walkMdxFiles(blogRoot);
  const entries = files.map((filePath) =>
    readMdxFile(filePath, slugPartsFor(blogRoot, filePath).join('/')),
  );
  return entries.sort((a, b) => (b.meta.date ?? '').localeCompare(a.meta.date ?? ''));
}

export function getPost(slug: string, root: string = DEFAULT_ROOT()): ContentEntry {
  const post = listPosts(root).find((entry) => entry.meta.slug === slug);
  if (!post) throw new Error(`No blog post found for slug "${slug}"`);
  return post;
}

export type LegalKind = 'terms' | 'privacy' | 'dpa';

export function getLegal(kind: LegalKind, root: string = DEFAULT_ROOT()): ContentEntry {
  const legalRoot = path.join(root, 'legal');
  const filePath = path.join(legalRoot, `${kind}.mdx`);
  try {
    return readMdxFile(filePath, kind);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`No legal document found for kind "${kind}"`, { cause: error });
    }
    throw error;
  }
}
