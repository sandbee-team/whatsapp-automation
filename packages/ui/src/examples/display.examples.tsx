import { Badge } from '../badge.js';
import { StatusDot } from '../status-dot.js';
import { Avatar } from '../avatar.js';
import { Card, CardHeader, CardTitle, CardDescription, CardBody, CardFooter } from '../card.js';
import { KpiStat } from '../kpi-stat.js';
import { Skeleton, SkeletonText, SkeletonRows } from '../skeleton.js';
import { EmptyState } from '../empty-state.js';
import { ErrorState } from '../error-state.js';
import { Spinner } from '../spinner.js';
import { Separator } from '../separator.js';
import { Alert } from '../alert.js';
import { Reveal, Stagger } from '../motion.js';
import type { UiExample } from './types.js';

/** Gallery cards for the display primitives (P26b U1b-2). */
export const displayExamples: readonly UiExample[] = [
  {
    name: 'Badge / tones',
    group: 'Display',
    render: () => (
      <div className="flex flex-wrap gap-2">
        <Badge tone="neutral">Draft</Badge>
        <Badge tone="success" dot>
          Live
        </Badge>
        <Badge tone="warning">Pending</Badge>
        <Badge tone="danger">Failed</Badge>
        <Badge tone="info">Synced</Badge>
        <Badge tone="accent" size="sm">
          New
        </Badge>
      </div>
    ),
  },
  {
    name: 'StatusDot',
    group: 'Display',
    render: () => (
      <div className="flex flex-col gap-2">
        <StatusDot tone="success" label="Live" pulse hideLabel={false} />
        <StatusDot tone="danger" label="Offline" hideLabel={false} />
      </div>
    ),
  },
  {
    name: 'Avatar / sizes',
    group: 'Display',
    render: () => (
      <div className="flex items-center gap-2">
        <Avatar name="Priya Sharma" size="sm" />
        <Avatar name="Arjun Mehta" size="md" />
        <Avatar name="प्रिया शर्मा" size="lg" shape="square" />
      </div>
    ),
  },
  {
    name: 'Card / interactive',
    group: 'Display',
    render: () => (
      <Card interactive>
        <CardHeader actions={<button type="button">Manage</button>}>
          <CardTitle>Dashboard</CardTitle>
          <CardDescription>An overview of your connected numbers.</CardDescription>
        </CardHeader>
        <CardBody>12 numbers connected.</CardBody>
        <CardFooter>
          <button type="button">Continue</button>
        </CardFooter>
      </Card>
    ),
  },
  {
    name: 'KpiStat',
    group: 'Display',
    render: () => (
      <div className="grid grid-cols-2 gap-4">
        <KpiStat
          label="Connected numbers"
          value="12"
          numericValue={12}
          tone="accent"
          hint="of 20 planned"
          delta={{ text: '+2 vs last week', direction: 'up' }}
          icon={<span aria-hidden="true">#</span>}
        />
        <KpiStat
          label="Spent today"
          value="Rs 240"
          tone="warning"
          hint="balance Rs 1,200"
          icon={<span aria-hidden="true">Rs</span>}
        />
        <KpiStat label="Connected numbers" value="12" loading />
      </div>
    ),
  },
  {
    name: 'Motion / Reveal + Stagger',
    group: 'Display',
    render: () => (
      <div className="flex flex-col gap-4">
        <Reveal variant="rise" className="rounded-lg border border-border bg-surface-2 p-3">
          Rises in on mount
        </Reveal>
        <Stagger stepMs={80} className="rounded-lg border border-border bg-surface-2 p-3">
          <div>First</div>
          <div>Second</div>
          <div>Third</div>
        </Stagger>
      </div>
    ),
  },
  {
    name: 'Skeleton / text / rows',
    group: 'Display',
    render: () => (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-24" />
        <SkeletonText lines={3} />
        <SkeletonRows rows={2} columns={3} />
      </div>
    ),
  },
  {
    name: 'EmptyState',
    group: 'Display',
    render: () => (
      <EmptyState
        title="No numbers connected yet"
        body="Connect a number to get started."
        action={<button type="button">Connect a number</button>}
        secondaryAction={<button type="button">Learn more</button>}
      />
    ),
  },
  {
    name: 'ErrorState',
    group: 'Display',
    render: () => (
      <ErrorState
        title="Couldn't load connected numbers"
        body="Check your connection and try again."
        retryAction={<button type="button">Retry</button>}
        details="request_id=abc123"
      />
    ),
  },
  {
    name: 'Spinner / sizes',
    group: 'Display',
    render: () => (
      <div className="flex items-center gap-3">
        <Spinner aria-label="Loading" size="sm" />
        <Spinner aria-label="Loading" size="md" />
        <Spinner aria-label="Loading" size="lg" />
      </div>
    ),
  },
  {
    name: 'Separator / labelled',
    group: 'Display',
    render: () => (
      <div className="flex w-64 flex-col gap-4">
        <Separator />
        <Separator label="or" />
      </div>
    ),
  },
  {
    name: 'Alert / tones',
    group: 'Display',
    render: () => (
      <div className="flex flex-col gap-3">
        <Alert tone="info" title="Heads up" body="Your safe mode is on." />
        <Alert
          tone="warning"
          title="Safe mode is on"
          body="Sends are paced to protect your numbers."
          onDismiss={() => {}}
          dismissLabel="Dismiss"
        />
        <Alert tone="danger" title="Failed to send" body="Try again in a moment." />
      </div>
    ),
  },
];
