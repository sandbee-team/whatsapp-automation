import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { queryClient } from './providers/query-client.js';
import { AdminI18nProvider } from './providers/i18n-provider.js';
import { ThemeProvider } from './providers/theme-provider.js';
import { routeTree } from './routeTree.gen.js';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App(): React.JSX.Element {
  return (
    <AdminI18nProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </AdminI18nProvider>
  );
}
