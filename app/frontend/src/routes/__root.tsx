import { createRootRoute, Link, Outlet, useRouter } from '@tanstack/react-router';
import { FileQuestion } from 'lucide-react';
import { EmptyState, ErrorState, Skeleton, useT } from '@wp/ui';

/**
 * Root route (URL shape only, no business logic - canon structure rule).
 * Every page renders inside this shell. `notFoundComponent`/`errorComponent`/
 * `pendingComponent` give every route a shared 404/error/loading shell so no
 * individual route has to hand-roll one; all copy through `@wp/i18n`.
 */
export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
  pendingComponent: PendingComponent,
});

function RootComponent(): React.JSX.Element {
  return (
    <main>
      <Outlet />
    </main>
  );
}

function NotFoundComponent(): React.JSX.Element {
  const t = useT();
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <EmptyState
        icon={<FileQuestion aria-hidden size={24} />}
        title={t('shell.notFound.title')}
        body={t('shell.notFound.body')}
        action={
          <Link
            to="/"
            className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium font-ui text-accent-fg hover:bg-accent-hover"
          >
            {t('shell.notFound.homeLink')}
          </Link>
        }
      />
    </div>
  );
}

function ErrorComponent(): React.JSX.Element {
  const t = useT();
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <ErrorState
        title={t('shell.errorBoundary.title')}
        body={t('shell.errorBoundary.body')}
        retryAction={
          <button
            type="button"
            onClick={() => void router.invalidate()}
            className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium font-ui text-accent-fg hover:bg-accent-hover"
          >
            {t('shell.errorBoundary.retryButton')}
          </button>
        }
      />
    </div>
  );
}

function PendingComponent(): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <div className="h-14 border-b border-border px-6 py-3">
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6 px-6 py-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}
