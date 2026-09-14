import { createFileRoute, notFound } from '@tanstack/react-router';
import { Gallery } from '@wp/ui';
import { useTheme } from '../providers/theme-provider.js';

/**
 * `/dev/gallery` (P26b) - the design-system gallery: every `@wp/ui`
 * primitive in its representative states, light and dark. Dev-only: the
 * loader throws `notFound()` unless Vite's `import.meta.env.DEV` is set, so a
 * production build serves the not-found screen here and ships no gallery
 * chunk to tenants (the route is code-split).
 */
export const Route = createFileRoute('/dev/gallery')({
  loader: () => {
    if (!import.meta.env.DEV) {
      throw notFound();
    }
  },
  component: GalleryRoute,
});

const THEME_ORDER = ['light', 'dark', 'system'] as const;

function GalleryRoute(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  return (
    <div className="min-h-screen bg-bg px-6 py-8 font-ui text-fg">
      <header className="mb-8 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Design system gallery</h1>
        <label className="flex items-center gap-2 text-sm">
          <span>Theme</span>
          <select
            data-testid="gallery-theme"
            value={theme}
            onChange={(event) => setTheme(event.target.value as (typeof THEME_ORDER)[number])}
            className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
          >
            {THEME_ORDER.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </header>
      <Gallery />
    </div>
  );
}
