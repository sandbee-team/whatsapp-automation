#!/usr/bin/env node
// serve-out.mjs (P29 U4b; compression added P29 step 6/U5b) - a
// dependency-free static file server for the Next.js static export
// (`website/out`), used by the Playwright e2e config and by the LCP perf
// gate (`tests/perf/lighthouse-runner.ts`). `trailingSlash: true` means
// every route is exported as `<path>/index.html`, so a request for
// `/contact/` (or `/contact`) must resolve to `out/contact/index.html` -
// this server implements exactly that resolution, plus content-negotiated
// compression, and nothing else (no caching headers, no directory
// listing): it exists to serve a build that already happened, never to
// build one.
//
// Production serves the export compressed at the edge (Caddy/nginx); this
// server mirrors that so the LCP gate measures the transfer bytes a real
// visitor receives, not the raw uncompressed file. Playwright's e2e
// (tests/e2e/lead-form.spec.ts) also uses this server - its behaviour is
// unchanged apart from the added encoding.
//
// Usage: `node serve-out.mjs <port> <dir>`

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const port = Number(process.argv[2] ?? 3002);
const rootArg = process.argv[3] ?? 'out';
const root = path.resolve(process.cwd(), rootArg);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// Only these MIME types are compressed - never images or fonts, which are
// already compressed formats where re-compressing wastes CPU for no gain.
const COMPRESSIBLE_TYPES = new Set([
  'text/html; charset=utf-8',
  'application/javascript',
  'text/javascript; charset=utf-8',
  'text/css; charset=utf-8',
  'application/json; charset=utf-8',
  'image/svg+xml',
  'text/plain; charset=utf-8',
  'application/manifest+json',
]);

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
}

/** Resolves a URL pathname to a file under `root`, following the trailing-slash/index.html export shape. */
async function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0] ?? '/');
  const candidates = decoded.endsWith('/')
    ? [path.join(root, decoded, 'index.html')]
    : [
        path.join(root, decoded),
        path.join(root, `${decoded}.html`),
        path.join(root, decoded, 'index.html'),
      ];

  for (const candidate of candidates) {
    // `startsWith(root)` alone would also accept a SIBLING directory whose
    // name merely has `root` as a string prefix (e.g. root `.../out` letting
    // through `.../out-secret`) - require the full path separator (or an
    // exact match on `root` itself) so only a real descendant of `root`
    // passes.
    if (candidate !== root && !candidate.startsWith(root + path.sep)) continue;
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/**
 * Picks the response body + headers for `body` given the request's
 * `Accept-Encoding`, mirroring what an edge proxy (Caddy/nginx) would do:
 * brotli preferred, then gzip, then identity. Never compresses a
 * non-compressible content type (images, fonts).
 */
function negotiateEncoding(body, contentType, acceptEncoding) {
  const headers = { Vary: 'Accept-Encoding' };
  if (!COMPRESSIBLE_TYPES.has(contentType)) {
    return { body, headers };
  }

  const accepted = acceptEncoding ?? '';
  if (accepted.includes('br')) {
    const compressed = zlib.brotliCompressSync(body, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
    });
    return { body: compressed, headers: { ...headers, 'Content-Encoding': 'br' } };
  }
  if (accepted.includes('gzip')) {
    const compressed = zlib.gzipSync(body, { level: 6 });
    return { body: compressed, headers: { ...headers, 'Content-Encoding': 'gzip' } };
  }
  return { body, headers };
}

const server = createServer(async (req, res) => {
  const found = await resolveFile(req.url ?? '/');
  if (found) {
    const raw = await readFile(found);
    const contentType = contentTypeFor(found);
    const { body, headers } = negotiateEncoding(raw, contentType, req.headers['accept-encoding']);
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      ...headers,
    });
    res.end(body);
    return;
  }

  const notFoundPage = path.join(root, '404.html');
  try {
    const raw = await readFile(notFoundPage);
    const { body, headers } = negotiateEncoding(
      raw,
      'text/html; charset=utf-8',
      req.headers['accept-encoding'],
    );
    res.writeHead(404, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      ...headers,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serve-out: serving ${root} on http://127.0.0.1:${port}/`);
});
