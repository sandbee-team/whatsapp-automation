import type * as React from 'react';
import { Badge, Button, Card } from '@wp/ui';

/**
 * ui-smoke.tsx (P29 U2) - the [R-30s] smoke: the first interactive
 * `@wp/ui` import into a Server Component must fail loudly at build (the
 * CI `website-build` step), never in production. This module has no
 * client-boundary directive of its own - `Button` carries its own.
 */
export function UiSmoke(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span data-ui-smoke="badge">
        <Badge tone="success">Pacing on by default</Badge>
      </span>
      <span data-ui-smoke="card">
        <Card padding="sm">Durable job storage, always on.</Card>
      </span>
      <span data-ui-smoke="button">
        <Button variant="outline" size="sm">
          Contact us
        </Button>
      </span>
    </div>
  );
}
