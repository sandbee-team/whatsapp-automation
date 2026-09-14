// Static export - no route handlers, no server actions, no middleware, no
// ISR (all forbidden by `output: 'export'`; the CI website-build step is
// what catches an accidental one).
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
  // `@wp/ui`'s barrel (`src/index.ts`) also re-exports `Gallery`, which
  // transitively imports its example gallery ('use client' demo modules).
  // Next's RSC build must trace every client boundary reachable from a
  // Server Component's imports, so importing anything from the bare
  // `@wp/ui` specifier pulls that whole graph in and breaks the
  // auto-generated `/_not-found` page's data collection. `modularizeImports`
  // rewrites each named import to its own submodule file, so a Server
  // Component that only imports Button/Card/Badge never touches Gallery.
  modularizeImports: {
    '@wp/ui': {
      transform: '@wp/ui/src/{{ kebabCase member }}.js',
      skipDefaultConversion: true,
    },
  },
  // The repo's relative-import idiom uses explicit `.js` extensions
  // resolving to `.ts`/`.tsx` source (tsconfig base: module NodeNext).
  // Next's webpack build has no built-in mapping for that (unlike `tsc`,
  // which special-cases it under NodeNext resolution) - `extensionAlias`
  // is webpack's documented mechanism for the same remapping.
  //
  // THIS CONFIG REQUIRES THE WEBPACK BUNDLER (2026-09-08). Next 16 enables
  // Turbopack by default and hard-errors when a `webpack` config is present
  // with no `turbopack` config, so BOTH scripts pass `--webpack` explicitly
  // (`next dev --webpack`, `next build --webpack`). Turbopack is not a drop-in
  // here: it exposes `resolveExtensions`/`resolveAlias` but no
  // `extensionAlias` equivalent, so the `.js` -> `.ts`/`.tsx` remapping above
  // has no Turbopack spelling. Migrating means changing the repo's import
  // idiom, not just this file - do not "fix" this by deleting the webpack
  // block or by adding an empty `turbopack: {}` (that silences the error but
  // then Turbopack runs and every `.js`-suffixed relative import fails).
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.tsx', '.ts', '.js'],
    };
    return config;
  },
};

export default nextConfig;
